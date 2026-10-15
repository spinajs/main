import { AuthzConfigError } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { DeleteQueryBuilder, InsertQueryBuilder, QueryMiddleware, UpdateQueryBuilder } from '@spinajs/orm';
import type { QueryBuilder } from '@spinajs/orm';

import { ormLog } from '../host.js';
import { entryOf, nameOf } from '../registry.js';
import type { ModelClass, ResourceEntry } from '../registry.js';
import { cleanupDeleted } from './cleanup.js';
import { rebuildFrom, removeNodes } from './rebuild.js';
import { insertedRefs, stillThere, targetRefs } from './targets.js';

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
 * Keeps authz_resource_ancestor right for writes of `@AccessResource` models (design §6.4). It never
 * changes a query; it reads the rows a write reaches and writes the table in the same transaction.
 */
@Injectable(QueryMiddleware)
export class AncestorMiddleware extends QueryMiddleware {
  public order = 90;

  private readonly targets = new WeakMap<object, ResourceRef[]>();
  private readonly warned = new WeakSet<ModelClass>();

  afterQueryCreation(_query: QueryBuilder): void {}

  transactional(query: QueryBuilder): boolean {
    return workOf(query)?.transactional === true;
  }

  async beforeQueryExecution(query: QueryBuilder): Promise<void> {
    const work = workOf(query);
    if (!work) return;
    if (work.transactional && query.Driver.CurrentTransaction === undefined) {
      throw new AuthzConfigError(`authz-orm: a ${work.kind} of ${nameOf(work.model)} (resource '${work.entry.type}') must run in a transaction so authz_resource_ancestor changes with it, and none could be opened on connection ${JSON.stringify(query.Driver.Options.Name)}`);
    }
    if (work.kind === 'update' || work.kind === 'delete') this.targets.set(query, await targetRefs(query as UpdateQueryBuilder<unknown>, work.model, work.entry));
  }

  async afterQueryExecution(query: QueryBuilder, result: unknown): Promise<void> {
    const work = workOf(query);
    if (!work) return;
    const driver = query.Driver;
    if (work.kind === 'insert') {
      const refs = insertedRefs(query as InsertQueryBuilder, result, work.entry);
      if (refs === undefined) return this.warnUnknownIds(work);
      await rebuildFrom(driver, refs);
      return;
    }
    const refs = this.targets.get(query) ?? [];
    this.targets.delete(query);
    if (refs.length === 0) return;
    if (work.kind === 'update') {
      await rebuildFrom(driver, refs);
      return;
    }
    const left = await stillThere(driver, work.model, work.entry, refs);
    const deleted = refs.filter((r) => !left.has(String(r.id)));
    await removeNodes(driver, deleted);
    await cleanupDeleted(driver, deleted);
  }

  private warnUnknownIds(work: Work): void {
    if (this.warned.has(work.model)) return;
    this.warned.add(work.model);
    ormLog().warn(`authz-orm: an insert of ${nameOf(work.model)} did not report the ids it wrote, so their authz_resource_ancestor rows are missing (access only narrows); insert one row at a time, supply the keys, or run authz:ancestors-rebuild ${work.entry.type}`);
  }
}
