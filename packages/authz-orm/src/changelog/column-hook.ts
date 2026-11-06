import { AuthzConfigError, changeLog, resourceKey } from '@spinajs/authz';
import type { ChangeEntry, ResourceRef } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { DeleteQueryBuilder, InsertQueryBuilder, QueryMiddleware, UpdateQueryBuilder } from '@spinajs/orm';
import type { OrmDriver, QueryBuilder } from '@spinajs/orm';

import { insertedRefs, targetRefs } from '../ancestors/targets.js';
import { ormLog } from '../host.js';
import { idLookup, idText, tableOf } from '../ids.js';
import { requireConnection } from '../records.js';
import { entryOf, nameOf } from '../registry.js';
import type { ModelClass, ResourceEntry } from '../registry.js';
import { columnChangesRecorded } from './db-changelog.js';
import { ChangeLogRecord } from './record.js';

/** One relation column of a resource: `@Parent` (relation `parent`), `@Owner` or `@Relation`. */
interface RelationColumn {
  readonly relation: string;
  readonly column: string;
  /** The type of the referenced object, when the column alone says it. */
  readonly type?: string;
  readonly typeColumn?: string;
}

interface Work {
  readonly kind: 'insert' | 'update' | 'delete';
  readonly model: ModelClass;
  readonly entry: ResourceEntry;
  readonly columns: readonly RelationColumn[];
}

type Values = ReadonlyMap<string, Readonly<Record<string, unknown>>>;

const IN_CHUNK = 500;

function relationColumns(entry: ResourceEntry): RelationColumn[] {
  const out: RelationColumn[] = entry.parents.map((p) => ({ relation: 'parent', column: p.column, type: p.type }));
  if (entry.owner) out.push({ relation: 'owner', column: entry.owner.column, ...(entry.owner.typeColumn ? { typeColumn: entry.owner.typeColumn } : { type: 'user' }) });
  for (const [relation, c] of Object.entries(entry.relations ?? {})) out.push({ relation, column: c.column, ...(c.typeColumn ? { typeColumn: c.typeColumn } : { type: 'user' }) });
  return out;
}

function workOf(query: QueryBuilder): Work | undefined {
  const model = query.Model as ModelClass | undefined;
  const entry = entryOf(model);
  if (!entry || !model || entry.changelog === false) return undefined;
  const columns = relationColumns(entry);
  if (columns.length === 0) return undefined;
  if (query instanceof InsertQueryBuilder) return { kind: 'insert', model, entry, columns };
  if (query instanceof DeleteQueryBuilder) return { kind: 'delete', model, entry, columns };
  if (query instanceof UpdateQueryBuilder) {
    const written = Object.keys(query.Value ?? {});
    return columns.some((c) => written.includes(c.column) || (c.typeColumn !== undefined && written.includes(c.typeColumn))) ? { kind: 'update', model, entry, columns } : undefined;
  }
  return undefined;
}

/** The relation columns of the rows with these ids, keyed by id; soft-deleted rows included. */
async function readValues(driver: OrmDriver, work: Work, ids: readonly string[]): Promise<Values> {
  const out = new Map<string, Record<string, unknown>>();
  const names = [...new Set([work.entry.idColumn, ...work.columns.flatMap((c) => (c.typeColumn ? [c.column, c.typeColumn] : [c.column]))])];
  const values = ids.map((id) => idLookup(work.model, work.entry.idColumn, id)).filter((v) => v !== undefined);
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const rows = (await driver.select().from(tableOf(work.model)).columns(names).whereIn(work.entry.idColumn, values.slice(i, i + IN_CHUNK))) as Record<string, unknown>[];
    for (const row of rows) {
      const id = idText(row[work.entry.idColumn]);
      if (id !== undefined) out.set(id, row);
    }
  }
  return out;
}

function refOf(c: RelationColumn, row: Readonly<Record<string, unknown>> | undefined): ResourceRef | null {
  const id = row === undefined ? undefined : idText(row[c.column]);
  if (id === undefined) return null;
  const type = c.typeColumn === undefined ? c.type : row?.[c.typeColumn];
  return typeof type === 'string' ? { type, id } : { type: '', id };
}

const sameRef = (a: ResourceRef | null, b: ResourceRef | null): boolean => (a === null || b === null ? a === b : a.type === b.type && a.id === b.id);

function changesOf(work: Work, before: Values, after: Values): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(id);
    const now = after.get(id);
    for (const c of work.columns) {
      const from = refOf(c, old);
      const to = refOf(c, now);
      if (sameRef(from, to)) continue;
      out.push({
        kind: 'column',
        op: old === undefined ? 'add' : now === undefined ? 'remove' : 'put',
        key: `${resourceKey({ type: work.entry.type, id })}#${c.relation}`,
        payload: { model: nameOf(work.entry.registered), column: c.column, old: from, new: to },
      });
    }
  }
  return out;
}

/**
 * Records the relation columns (`@Parent`, `@Owner`, `@Relation`) of `@AccessResource` rows in the changelog (G15,
 * kind `column`): replay reads relationships straight from those columns, so their history must be kept. Reads the
 * rows a write reaches before and after it, and appends what changed in the write's own transaction.
 */
@Injectable(QueryMiddleware)
export class ColumnChangeMiddleware extends QueryMiddleware {
  public order = 91;

  private readonly before = new WeakMap<object, Values>();
  private readonly warned = new WeakSet<ModelClass>();

  afterQueryCreation(_query: QueryBuilder): void {}

  transactional(query: QueryBuilder): boolean {
    return workOf(query) !== undefined;
  }

  async beforeQueryExecution(query: QueryBuilder): Promise<void> {
    const work = workOf(query);
    if (!work) return;
    if (query.Driver.CurrentTransaction === undefined) {
      throw new AuthzConfigError(`authz-orm: a ${work.kind} of ${nameOf(work.model)} (resource '${work.entry.type}') must run in a transaction so its relation columns reach the changelog with it, and none could be opened on connection ${JSON.stringify(query.Driver.Options.Name)}`);
    }
    requireConnection(ChangeLogRecord, query.Driver, `authz-orm: a ${work.kind} of ${nameOf(work.model)} (resource '${work.entry.type}')`);
    this.before.set(query, await readValues(query.Driver, work, await this.idsBefore(query, work)));
  }

  async afterQueryExecution(query: QueryBuilder, result: unknown): Promise<void> {
    const work = workOf(query);
    if (!work) return;
    const before = this.before.get(query) ?? new Map();
    this.before.delete(query);
    let ids = [...before.keys()];
    if (work.kind === 'insert') {
      const refs = insertedRefs(query as InsertQueryBuilder, result, work.entry);
      if (refs === undefined) return this.warnUnknownIds(work);
      ids = refs.map((r) => String(r.id));
    }
    await changeLog().append(changesOf(work, before, await readValues(query.Driver, work, ids)));
  }

  /** Rows an update or delete reaches; for an upsert, the supplied ids it may overwrite; none for a plain insert. */
  private async idsBefore(query: QueryBuilder, work: Work): Promise<string[]> {
    if (work.kind !== 'insert') return (await targetRefs(query as UpdateQueryBuilder<unknown>, work.model, work.entry)).map((r) => String(r.id));
    const insert = query as InsertQueryBuilder;
    if (insert.Ignore !== true && !insert.Replace && !insert.Update) return [];
    return insert
      .getColumnValues(work.entry.idColumn)
      .map((v) => idText(v))
      .filter((v): v is string => v !== undefined);
  }

  private warnUnknownIds(work: Work): void {
    if (this.warned.has(work.model)) return;
    this.warned.add(work.model);
    ormLog().warn({ model: nameOf(work.model), resourceType: work.entry.type }, 'authz-orm: an insert of ${model} did not report the ids it wrote, so the changelog misses their relation columns; insert one row at a time or supply the keys');
  }
}

columnChangesRecorded();
