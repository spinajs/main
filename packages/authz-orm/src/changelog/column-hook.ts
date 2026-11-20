import { AuthzConfigError, changeLog, resourceKey } from '@spinajs/authz';
import type { ChangeEntry, ResourceRef } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, RowChange, WriteStatement } from '@spinajs/orm';

import { ormLog } from '../host.js';
import { idText } from '../ids.js';
import { requireConnection } from '../records.js';
import { changelogColumns, entryOf, nameOf } from '../registry.js';
import type { ModelClass, RelationColumn, ResourceEntry } from '../registry.js';
import { columnChangesRecorded } from './db-changelog.js';
import { ChangeLogRecord } from './record.js';

interface Work {
  readonly kind: 'insert' | 'update' | 'delete';
  readonly model: ModelClass;
  readonly entry: ResourceEntry;
  readonly columns: readonly RelationColumn[];
}

function workOf({ kind, model, query }: WriteStatement): Work | undefined {
  const entry = entryOf(model);
  if (!entry || entry.changelog === false) return undefined;
  const columns = changelogColumns(entry);
  if (columns.length === 0) return undefined;
  if (kind === 'update') {
    const written = Object.keys(query.Value ?? {});
    if (!columns.some((c) => written.includes(c.column) || (c.typeColumn !== undefined && written.includes(c.typeColumn)))) return undefined;
  }
  return { kind, model, entry, columns };
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

  interest(statement: WriteStatement): CaptureInterest | undefined {
    const work = this.workOf(statement);
    return work ? { columns: columnNames(work), transactional: true } : undefined;
  }

  prepare(statement: WriteStatement): void {
    const work = this.workOf(statement);
    if (!work) return;
    const { query } = statement;
    if (query.Driver.CurrentTransaction === undefined) {
      throw new AuthzConfigError(`authz-orm: a ${work.kind} of ${nameOf(work.model)} (resource '${work.entry.type}') must run in a transaction so its relation columns reach the changelog with it, and none could be opened on connection ${JSON.stringify(query.Driver.Options.Name)}`);
    }
    requireConnection(ChangeLogRecord, query.Driver, `authz-orm: a ${work.kind} of ${nameOf(work.model)} (resource '${work.entry.type}')`);
  }

  async observe(write: CapturedWrite): Promise<void> {
    const work = this.workOf(write);
    if (!work) return;
    if (write.unknownKeys) {
      await changeLog().lost('column', work.entry.type, 'insert without returned ids');
      return this.insertWithoutIds(work);
    }
    await changeLog().append(changesOf(work, write.rows));
  }

  private workOf(statement: WriteStatement): Work | undefined {
    if (!this.work.has(statement.query)) this.work.set(statement.query, workOf(statement) ?? null);
    return this.work.get(statement.query) ?? undefined;
  }

  /** An insert whose ids the driver did not report: its relation columns cannot be read back. */
  private insertWithoutIds(work: Work): void {
    if (this.warned.has(work.model)) return;
    this.warned.add(work.model);
    ormLog().warn({ model: nameOf(work.model), resourceType: work.entry.type }, 'authz-orm: an insert of ${model} did not report the ids it wrote, so the changelog misses their relation columns; insert one row at a time or supply the keys');
  }
}

columnChangesRecorded();
