import { Configuration } from '@spinajs/configuration-common';
import { DI, Injectable } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';

import { DeleteQueryBuilder, InsertQueryBuilder, UpdateQueryBuilder } from '../builders.js';
import type { QueryBuilder } from '../builders.js';
import { extractModelDescriptor } from '../descriptor.js';
import { WriteCaptureLimitExceeded } from '../exceptions.js';
import { QueryMiddleware } from '../interfaces.js';
import type { ModelBase } from '../model.js';
import { WriteObserver } from './contracts.js';
import type { CaptureInterest, CaptureKind, CapturedRow, RowChange } from './contracts.js';
import { captureKeyText, insertedKeys, upsertKeys, writeTargetKeys } from './keys.js';
import { readRows } from './read.js';

interface Watch {
  readonly observer: WriteObserver;
  readonly interest: CaptureInterest;
}

interface Plan {
  readonly kind: CaptureKind;
  readonly model: Constructor<ModelBase>;
  readonly table: string;
  readonly pk: string;
  readonly watches: readonly Watch[];
  readonly columns: readonly string[] | '*';
}

interface Pending {
  readonly plan: Plan;
  readonly before: ReadonlyMap<string, CapturedRow>;
  /** An upsert's conflict columns, empty for any other statement; undefined when the rows of the upsert cannot be known. */
  readonly conflict: readonly string[] | undefined;
}

function kindOf(query: QueryBuilder): CaptureKind | undefined {
  if (query instanceof InsertQueryBuilder) return 'insert';
  if (query instanceof UpdateQueryBuilder) return 'update';
  if (query instanceof DeleteQueryBuilder) return 'delete';
  return undefined;
}

function unionColumns(watches: readonly Watch[]): readonly string[] | '*' {
  const columns = new Set<string>();
  for (const { interest } of watches) {
    if (interest.columns === '*') return '*';
    for (const c of interest.columns) columns.add(c);
  }
  return [...columns];
}

// Resolved per statement, like the middlewares of every builder: the list follows DI.register, DI.unregister and
// DI.clearCache, and Array.ofType returns it in registration order.
const observers = (): WriteObserver[] => DI.resolve(Array.ofType(WriteObserver));

function planOf(query: QueryBuilder): Plan | undefined {
  const kind = kindOf(query);
  const model = query.Model;
  if (!kind || !model) return undefined;
  const watches = observers().flatMap((observer) => {
    const interest = observer.interest(query);
    return interest ? [{ observer, interest }] : [];
  });
  if (watches.length === 0) return undefined;
  const d = extractModelDescriptor(model);
  if (!d || d.PrimaryKey.length !== 1) throw new InvalidOperation(`write capture: ${model.name} needs a single-column primary key, it has ${d?.PrimaryKey.length ?? 0}`);
  return { kind, model, table: d.TableName, pk: d.PrimaryKey[0], watches, columns: unionColumns(watches) };
}

function maxRows(): number {
  const n = DI.get(Configuration)?.get<unknown>('db.WriteCapture.MaxRows', 0);
  return typeof n === 'number' && n > 0 ? n : Infinity;
}

function project(row: CapturedRow | undefined, pk: string, columns: readonly string[] | '*'): CapturedRow | undefined {
  if (row === undefined || columns === '*') return row;
  const wanted = new Set([pk, ...columns]);
  return Object.fromEntries(Object.entries(row).filter(([c]) => wanted.has(c)));
}

function changesOf(before: ReadonlyMap<string, CapturedRow>, after: ReadonlyMap<string, CapturedRow>): RowChange[] {
  return [...new Set([...before.keys(), ...after.keys()])].map((id) => ({ id, before: before.get(id), after: after.get(id) }));
}

const isUpsert = (query: InsertQueryBuilder): boolean => query.Ignore === true || query.Replace || query.Update;

// The column flag Unique cannot be used: PostgreSQL and MySQL set it on every member of a composite unique index.
async function uniqueKeys(query: InsertQueryBuilder, plan: Plan): Promise<string[][]> {
  const live = await query.Driver.tableIndexes?.(plan.table);
  if (live) return live.filter((i) => i.unique && !i.primary).map((i) => i.columns);
  return [...(extractModelDescriptor(plan.model)?.Indexes?.values() ?? [])].filter((i) => i.unique).map((i) => i.columns);
}

const searchable = (query: InsertQueryBuilder, column: string): boolean => query.getColumnValues(column).every((v) => v === null || v === undefined || captureKeyText(v) !== undefined);

/**
 * What an upsert may conflict on: the primary key, every single-column unique index and its own conflict target.
 * Undefined when it may conflict on a key over several columns, or supplies a value no key text holds (a date, bytes).
 */
async function conflictColumns(query: InsertQueryBuilder, plan: Plan): Promise<string[] | undefined> {
  const target = query.Update ? query.DuplicateQueryBuilder.getColumn() : [];
  const keys = [[plan.pk], ...(await uniqueKeys(query, plan)), ...(target.length > 0 ? [target] : [])];
  if (keys.some((k) => k.length !== 1)) return undefined;
  const columns = [...new Set(keys.map(([c]) => c))];
  return columns.every((c) => searchable(query, c)) ? columns : undefined;
}

/** The rows holding a value the upsert supplies for one of its conflict columns: the rows it may update or replace. */
async function conflictingRows(query: InsertQueryBuilder, plan: Plan, columns: readonly string[]): Promise<Map<string, CapturedRow>> {
  const out = new Map<string, CapturedRow>();
  for (const column of columns) {
    for (const [key, row] of await readRows(query.Driver, plan.model, plan.table, plan.pk, plan.columns, upsertKeys(query, column), column)) out.set(key, row);
  }
  refuseAbove(plan, out.size, maxRows());
  return out;
}

/** Every row supplies a conflict value, so the rows the upsert wrote are found by those values after it. */
function everyRowConflicts(query: InsertQueryBuilder, columns: readonly string[]): boolean {
  const values = columns.map((c) => query.getColumnValues(c));
  return query.Values.every((_, i) => values.some((v) => captureKeyText(v.at(i)) !== undefined));
}

function refuseAbove(plan: Plan, rows: number, max: number): void {
  if (rows > max) throw new WriteCaptureLimitExceeded(`write capture: an ${plan.kind} of ${plan.model.name} reaches ${rows} rows, above db.WriteCapture.MaxRows (${max}); narrow the statement or raise the limit`);
}

async function targetRows(query: QueryBuilder, plan: Plan, conflict: readonly string[] | undefined): Promise<Map<string, CapturedRow>> {
  const max = maxRows();
  if (query instanceof InsertQueryBuilder) {
    refuseAbove(plan, query.Values.length, max);
    return conflict && conflict.length > 0 ? conflictingRows(query, plan, conflict) : new Map<string, CapturedRow>();
  }
  // One key above the limit is enough to refuse, so a runaway statement never loads all of its keys.
  const keys = query instanceof UpdateQueryBuilder || query instanceof DeleteQueryBuilder ? await writeTargetKeys(query, plan.pk, max === Infinity ? undefined : max + 1) : [];
  refuseAbove(plan, keys.length, max);
  return readRows(query.Driver, plan.model, plan.table, plan.pk, plan.columns, keys);
}

/** Undefined when the rows an insert wrote cannot be known. */
async function rowsAfter(query: QueryBuilder, { plan, before, conflict }: Pending, result: unknown): Promise<ReadonlyMap<string, CapturedRow> | undefined> {
  const byBeforeKeys = () => readRows(query.Driver, plan.model, plan.table, plan.pk, plan.columns, [...before.keys()]);
  if (!(query instanceof InsertQueryBuilder)) return allDeleted(plan, before, result) ? new Map<string, CapturedRow>() : byBeforeKeys();
  if (conflict === undefined) return undefined;
  const upsert = conflict.length > 0;
  // A row found before is read again by its key too: an update of its conflict column would hide it from the values.
  const conflicting = upsert ? new Map([...(await byBeforeKeys()), ...(await conflictingRows(query, plan, conflict))]) : new Map<string, CapturedRow>();
  if (upsert && everyRowConflicts(query, conflict)) return conflicting;
  const keys = insertedKeys(query, result, plan.pk);
  if (keys === undefined) return undefined;
  const inserted = await readRows(query.Driver, plan.model, plan.table, plan.pk, plan.columns, keys.filter((k) => !conflicting.has(k)));
  return new Map([...conflicting, ...inserted]);
}

function rowsAffected(result: unknown): unknown {
  return typeof result === 'object' && result !== null && 'RowsAffected' in result ? result.RowsAffected : undefined;
}

const allDeleted = (plan: Plan, before: ReadonlyMap<string, CapturedRow>, result: unknown): boolean => plan.kind === 'delete' && rowsAffected(result) === before.size;

/**
 * Reads the rows a write reaches before and after it, once for every interested `WriteObserver`, and hands each its
 * projection. Order 91: after authz-orm's ancestors (90), before its guard (95) and access lists (100).
 */
@Injectable(QueryMiddleware)
export class WriteCaptureMiddleware extends QueryMiddleware {
  public order = 91;

  private readonly plans = new WeakMap<object, Plan | null>();
  private readonly pending = new WeakMap<object, Pending>();

  afterQueryCreation(_query: QueryBuilder): void {}

  transactional(query: QueryBuilder): boolean {
    return this.plan(query)?.watches.some((w) => w.interest.transactional) === true;
  }

  async beforeQueryExecution(query: QueryBuilder): Promise<void> {
    const plan = this.plan(query);
    if (!plan) return;
    for (const w of plan.watches) await w.observer.prepare?.(query);
    const conflict = query instanceof InsertQueryBuilder && isUpsert(query) ? await conflictColumns(query, plan) : [];
    this.pending.set(query, { plan, conflict, before: await targetRows(query, plan, conflict) });
  }

  async afterQueryExecution(query: QueryBuilder, result: unknown): Promise<void> {
    const pending = this.pending.get(query);
    if (!pending) return;
    this.pending.delete(query);
    const { plan, before } = pending;
    const after = await rowsAfter(query, pending, result);
    const changes = after === undefined ? [] : changesOf(before, after);
    for (const { observer, interest } of plan.watches) {
      await observer.observe({
        kind: plan.kind,
        query,
        model: plan.model,
        driver: query.Driver,
        unknownKeys: after === undefined,
        rows: changes.map((c) => ({ id: c.id, before: project(c.before, plan.pk, interest.columns), after: project(c.after, plan.pk, interest.columns) })),
      });
    }
  }

  private plan(query: QueryBuilder): Plan | undefined {
    if (!this.plans.has(query)) this.plans.set(query, planOf(query) ?? null);
    return this.plans.get(query) ?? undefined;
  }
}
