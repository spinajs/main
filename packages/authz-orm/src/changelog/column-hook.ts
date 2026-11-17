import { AuthzConfigError, changeLog, resourceKey } from '@spinajs/authz';
import type { ChangeEntry, ResourceRef } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { DeleteQueryBuilder, InsertQueryBuilder, UpdateQueryBuilder, WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, QueryBuilder, RowChange } from '@spinajs/orm';

import { ormLog } from '../host.js';
import { idText } from '../ids.js';
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

function refOf(c: RelationColumn, row: Readonly<Record<string, unknown>> | undefined): ResourceRef | null {
  const id = row === undefined ? undefined : idText(row[c.column]);
  if (id === undefined) return null;
  const type = c.typeColumn === undefined ? c.type : row?.[c.typeColumn];
  return typeof type === 'string' ? { type, id } : { type: '', id };
}

const sameRef = (a: ResourceRef | null, b: ResourceRef | null): boolean => (a === null || b === null ? a === b : a.type === b.type && a.id === b.id);

function changesOf(work: Work, rows: readonly RowChange[]): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  for (const { id, before, after } of rows) {
    for (const c of work.columns) {
      const from = refOf(c, before);
      const to = refOf(c, after);
      if (sameRef(from, to)) continue;
      out.push({
        kind: 'column',
        op: before === undefined ? 'add' : after === undefined ? 'remove' : 'put',
        key: `${resourceKey({ type: work.entry.type, id })}#${c.relation}`,
        payload: { model: nameOf(work.entry.registered), column: c.column, old: from, new: to },
      });
    }
  }
  return out;
}

const columnNames = (work: Work): string[] => [...new Set(work.columns.flatMap((c) => (c.typeColumn ? [c.column, c.typeColumn] : [c.column])))];

/**
 * Records the relation columns (`@Parent`, `@Owner`, `@Relation`) of `@AccessResource` rows in the changelog (G15,
 * kind `column`): replay reads relationships straight from those columns, so their history must be kept. The ORM write
 * capture reads the rows a write reaches before and after it; this appends what changed in the write's own transaction.
 */
@Injectable(WriteObserver)
export class ColumnChangeObserver extends WriteObserver {
  private readonly work = new WeakMap<object, Work | null>();
  private readonly warned = new WeakSet<ModelClass>();

  interest(query: QueryBuilder): CaptureInterest | undefined {
    const work = this.workOf(query);
    return work ? { columns: columnNames(work), transactional: true } : undefined;
  }

  prepare(query: QueryBuilder): void {
    const work = this.workOf(query);
    if (!work) return;
    if (query.Driver.CurrentTransaction === undefined) {
      throw new AuthzConfigError(`authz-orm: a ${work.kind} of ${nameOf(work.model)} (resource '${work.entry.type}') must run in a transaction so its relation columns reach the changelog with it, and none could be opened on connection ${JSON.stringify(query.Driver.Options.Name)}`);
    }
    requireConnection(ChangeLogRecord, query.Driver, `authz-orm: a ${work.kind} of ${nameOf(work.model)} (resource '${work.entry.type}')`);
  }

  async observe(write: CapturedWrite): Promise<void> {
    const work = this.workOf(write.query);
    if (!work) return;
    if (write.unknownKeys) return this.insertWithoutIds(work);
    await changeLog().append(changesOf(work, write.rows));
  }

  private workOf(query: QueryBuilder): Work | undefined {
    if (!this.work.has(query)) this.work.set(query, workOf(query) ?? null);
    return this.work.get(query) ?? undefined;
  }

  /** An insert whose ids the driver did not report: its relation columns cannot be read back. */
  private insertWithoutIds(work: Work): void {
    if (this.warned.has(work.model)) return;
    this.warned.add(work.model);
    ormLog().warn({ model: nameOf(work.model), resourceType: work.entry.type }, 'authz-orm: an insert of ${model} did not report the ids it wrote, so the changelog misses their relation columns; insert one row at a time or supply the keys');
  }
}

columnChangesRecorded();
