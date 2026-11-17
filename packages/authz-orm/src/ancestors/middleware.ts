import { AuthzConfigError } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { DeleteQueryBuilder, InsertQueryBuilder, UpdateQueryBuilder, WriteObserver, upsertKeys } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, QueryBuilder } from '@spinajs/orm';

import { ormLog } from '../host.js';
import { requireConnection } from '../records.js';
import { entryOf, nameOf } from '../registry.js';
import type { ModelClass, ResourceEntry } from '../registry.js';
import { cleanupDeleted } from './cleanup.js';
import { AncestorRecord } from './record.js';
import { rebuildFrom, removeNodes } from './rebuild.js';

interface Work {
  readonly kind: 'insert' | 'update' | 'delete';
  readonly model: ModelClass;
  readonly entry: ResourceEntry;
  readonly transactional: boolean;
}

function workOf(query: QueryBuilder): Work | undefined {
  const model = query.Model as ModelClass | undefined;
  const entry = entryOf(model);
  if (!entry || !model) return undefined;
  if (query instanceof DeleteQueryBuilder) return { kind: 'delete', model, entry, transactional: true };
  if (entry.parents.length === 0) return undefined;
  if (query instanceof InsertQueryBuilder) return { kind: 'insert', model, entry, transactional: query.Ignore === true || query.Replace || query.Update };
  if (query instanceof UpdateQueryBuilder) {
    const written = Object.keys((query.Value ?? {}) as Record<string, unknown>);
    return entry.parents.some((p) => written.includes(p.column)) ? { kind: 'update', model, entry, transactional: true } : undefined;
  }
  return undefined;
}

/**
 * Keeps authz_resource_ancestor right for writes of `@AccessResource` models (design §6.4). It never changes a query:
 * the ORM write capture reads the rows a write reaches, and this writes the table in the write's own transaction.
 */
@Injectable(WriteObserver)
export class AncestorObserver extends WriteObserver {
  private readonly work = new WeakMap<object, Work | null>();
  private readonly warned = new WeakSet<ModelClass>();

  interest(query: QueryBuilder): CaptureInterest | undefined {
    const work = this.workOf(query);
    return work ? { columns: [work.entry.idColumn, ...new Set(work.entry.parents.map((p) => p.column))], transactional: work.transactional } : undefined;
  }

  prepare(query: QueryBuilder): void {
    const work = this.workOf(query);
    if (!work) return;
    if (work.transactional && query.Driver.CurrentTransaction === undefined) {
      throw new AuthzConfigError(`authz-orm: a ${work.kind} of ${nameOf(work.model)} (resource '${work.entry.type}') must run in a transaction so authz_resource_ancestor changes with it, and none could be opened on connection ${JSON.stringify(query.Driver.Options.Name)}`);
    }
    requireConnection(AncestorRecord, query.Driver, `authz-orm: a ${work.kind} of ${nameOf(work.model)} (resource '${work.entry.type}')`);
  }

  async observe(write: CapturedWrite): Promise<void> {
    const work = this.workOf(write.query);
    if (!work) return;
    const refsOf = (ids: readonly string[]): ResourceRef[] => ids.map((id) => ({ type: work.entry.type, id }));
    if (write.unknownKeys) {
      this.insertWithoutIds(work);
      // An upsert still names the keys of rows it may have moved under another parent; access must not keep the old one.
      if (write.query instanceof InsertQueryBuilder) await rebuildFrom(write.driver, refsOf(upsertKeys(write.query, work.entry.idColumn)));
      return;
    }
    if (work.kind === 'update') {
      await rebuildFrom(write.driver, refsOf(write.rows.map((r) => r.id)));
      return;
    }
    if (work.kind === 'insert') await rebuildFrom(write.driver, refsOf(write.rows.filter((r) => r.after !== undefined).map((r) => r.id)));
    // A delete, or the rows a replace deleted through a unique column.
    const gone = refsOf(write.rows.filter((r) => r.after === undefined).map((r) => r.id));
    await removeNodes(write.driver, gone);
    await cleanupDeleted(write.driver, gone);
  }

  private workOf(query: QueryBuilder): Work | undefined {
    if (!this.work.has(query)) this.work.set(query, workOf(query) ?? null);
    return this.work.get(query) ?? undefined;
  }

  /** An insert whose ids the driver did not report, or an upsert whose rows the capture could not find. */
  private insertWithoutIds(work: Work): void {
    if (this.warned.has(work.model)) return;
    this.warned.add(work.model);
    ormLog().warn({ model: nameOf(work.model), resourceType: work.entry.type }, 'authz-orm: an insert of ${model} did not report the rows it wrote, so authz_resource_ancestor may miss them, or keep the old parent of a row an upsert moved without naming its key; insert one row at a time, supply the keys, or run authz:ancestors-rebuild ${resourceType}');
  }
}
