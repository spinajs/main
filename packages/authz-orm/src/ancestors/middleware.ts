import { AuthzConfigError } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { DeleteQueryBuilder, InsertQueryBuilder, UpdateQueryBuilder, WriteObserver } from '@spinajs/orm';
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
    if (write.unknownKeys) return this.insertWithoutIds(work);
    const refsOf = (rows: CapturedWrite['rows']): ResourceRef[] => rows.map((r) => ({ type: work.entry.type, id: r.id }));
    if (work.kind !== 'delete') {
      await rebuildFrom(write.driver, refsOf(write.rows));
      return;
    }
    const deleted = refsOf(write.rows.filter((r) => r.after === undefined));
    await removeNodes(write.driver, deleted);
    await cleanupDeleted(write.driver, deleted);
  }

  private workOf(query: QueryBuilder): Work | undefined {
    if (!this.work.has(query)) this.work.set(query, workOf(query) ?? null);
    return this.work.get(query) ?? undefined;
  }

  /** An insert whose ids the driver did not report: its new rows cannot be placed in the table. */
  private insertWithoutIds(work: Work): void {
    if (this.warned.has(work.model)) return;
    this.warned.add(work.model);
    ormLog().warn({ model: nameOf(work.model), resourceType: work.entry.type }, 'authz-orm: an insert of ${model} did not report the ids it wrote, so their authz_resource_ancestor rows are missing (access only narrows); insert one row at a time, supply the keys, or run authz:ancestors-rebuild ${resourceType}');
  }
}
