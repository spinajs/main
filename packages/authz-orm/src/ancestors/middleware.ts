import { AuthzConfigError } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { WriteObserver, upsertKeys } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, OrmDriver, WriteStatement } from '@spinajs/orm';

import { ormLog } from '../host.js';
import { requireConnection } from '../records.js';
import { entryOf, hasChildTypes, nameOf } from '../registry.js';
import type { ModelClass, ResourceEntry } from '../registry.js';
import { cleanupDeleted } from './cleanup.js';
import { AncestorRecord } from './record.js';
import { rebuildFrom, removeNodes } from './rebuild.js';
import { readChildrenNaming } from './store.js';

interface Work {
  readonly kind: 'insert' | 'update' | 'delete';
  readonly model: ModelClass;
  readonly entry: ResourceEntry;
  readonly transactional: boolean;
}

function workOf(statement: WriteStatement): Work | undefined {
  const { model } = statement;
  const entry = entryOf(model);
  if (!entry) return undefined;
  if (statement.kind === 'delete') return { kind: 'delete', model, entry, transactional: true };
  // An insert of a type that other types name in @Parent links the children already naming the new row.
  if (entry.parents.length === 0 && (statement.kind !== 'insert' || !hasChildTypes(entry.type))) return undefined;
  if (statement.kind === 'insert') {
    const { query } = statement;
    return { kind: 'insert', model, entry, transactional: query.Ignore === true || query.Replace || query.Update };
  }
  const written = Object.keys(statement.query.Value ?? {});
  return entry.parents.some((p) => written.includes(p.column)) ? { kind: 'update', model, entry, transactional: true } : undefined;
}

/**
 * Keeps authz_resource_ancestor right for writes of `@AccessResource` models (design §6.4). It never changes a query:
 * the ORM write capture reads the rows a write reaches, and this writes the table in the write's own transaction.
 */
@Injectable(WriteObserver)
export class AncestorObserver extends WriteObserver {
  private readonly work = new WeakMap<object, Work | null>();
  private readonly warned = new WeakSet<ModelClass>();

  interest(statement: WriteStatement): CaptureInterest | undefined {
    const work = this.workOf(statement);
    return work ? { columns: [work.entry.idColumn, ...new Set(work.entry.parents.map((p) => p.column))], transactional: work.transactional } : undefined;
  }

  prepare(statement: WriteStatement): void {
    const work = this.workOf(statement);
    if (!work) return;
    const { query } = statement;
    if (work.transactional && query.Driver.CurrentTransaction === undefined) {
      throw new AuthzConfigError(`authz-orm: a ${work.kind} of ${nameOf(work.model)} (resource '${work.entry.type}') must run in a transaction so authz_resource_ancestor changes with it, and none could be opened on connection ${JSON.stringify(query.Driver.Options.Name)}`);
    }
    requireConnection(AncestorRecord, query.Driver, `authz-orm: a ${work.kind} of ${nameOf(work.model)} (resource '${work.entry.type}')`);
  }

  async observe(write: CapturedWrite): Promise<void> {
    const work = this.workOf(write);
    if (!work) return;
    const refsOf = (ids: readonly string[]): ResourceRef[] => ids.map((id) => ({ type: work.entry.type, id }));
    if (write.unknownKeys) {
      this.insertWithoutIds(work);
      // An upsert still names the keys of rows it may have moved under another parent; access must not keep the old one.
      if (write.kind === 'insert') await this.inserted(write.driver, work, refsOf(upsertKeys(write.query, work.entry.idColumn)));
      return;
    }
    if (work.kind === 'update') {
      await rebuildFrom(write.driver, refsOf(write.rows.map((r) => r.id)));
      return;
    }
    if (work.kind === 'insert') await this.inserted(write.driver, work, refsOf(write.rows.filter((r) => r.after !== undefined).map((r) => r.id)));
    // A delete, or the rows a replace deleted through a unique column.
    const gone = refsOf(write.rows.filter((r) => r.after === undefined).map((r) => r.id));
    await removeNodes(write.driver, gone);
    await cleanupDeleted(write.driver, gone);
  }

  /** A row written through a class without `@Parent` gets no links of its own (01c0d), but the children naming it do. */
  private async inserted(driver: OrmDriver, work: Work, rows: readonly ResourceRef[]): Promise<void> {
    await rebuildFrom(driver, [...(work.entry.parents.length > 0 ? rows : []), ...(await readChildrenNaming(driver, rows))]);
  }

  private workOf(statement: WriteStatement): Work | undefined {
    if (!this.work.has(statement.query)) this.work.set(statement.query, workOf(statement) ?? null);
    return this.work.get(statement.query) ?? undefined;
  }

  /** An insert whose ids the driver did not report, or an upsert whose rows the capture could not find. */
  private insertWithoutIds(work: Work): void {
    if (this.warned.has(work.model)) return;
    this.warned.add(work.model);
    ormLog().warn({ model: nameOf(work.model), resourceType: work.entry.type }, 'authz-orm: an insert of ${model} did not report the rows it wrote, so authz_resource_ancestor may miss them, or keep the old parent of a row an upsert moved without naming its key; insert one row at a time or supply the keys; authz:ancestors-verify ${resourceType} finds such rows and authz:ancestors-rebuild ${resourceType} repairs them');
  }
}
