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

/** What an upsert may conflict on: the primary key, every unique column and its own conflict target. */
function conflictColumns(query: InsertQueryBuilder, plan: Plan): string[] {
  const unique = extractModelDescriptor(plan.model)?.Columns.filter((c) => c.Unique).map((c) => c.Name) ?? [];
  return [...new Set([plan.pk, ...unique, ...(query.Update ? query.DuplicateQueryBuilder.getColumn() : [])])];
}

/** The rows holding a value the upsert supplies for one of its conflict columns: the rows it may update or replace. */
async function conflictingRows(query: InsertQueryBuilder, plan: Plan): Promise<Map<string, CapturedRow>> {
  const out = new Map<string, CapturedRow>();
  for (const column of conflictColumns(query, plan)) {
    for (const [key, row] of await readRows(query.Driver, plan.model, plan.table, plan.pk, plan.columns, upsertKeys(query, column), column)) out.set(key, row);
  }
  return out;
}

/** Every row supplies a conflict value, so the rows the upsert wrote are found by those values after it. */
function everyRowConflicts(query: InsertQueryBuilder, plan: Plan): boolean {
  const values = conflictColumns(query, plan).map((c) => query.getColumnValues(c));
  return query.Values.every((_, i) => values.some((v) => captureKeyText(v.at(i)) !== undefined));
}

function refuseAbove(plan: Plan, rows: number, max: number): void {
  if (rows > max) throw new WriteCaptureLimitExceeded(`write capture: an ${plan.kind} of ${plan.model.name} reaches ${rows} rows, above db.WriteCapture.MaxRows (${max}); narrow the statement or raise the limit`);
}

async function targetRows(query: QueryBuilder, plan: Plan): Promise<Map<string, CapturedRow>> {
  const max = maxRows();
  if (query instanceof InsertQueryBuilder) {
    refuseAbove(plan, query.Values.length, max);
    return isUpsert(query) ? conflictingRows(query, plan) : new Map<string, CapturedRow>();
  }
  // One key above the limit is enough to refuse, so a runaway statement never loads all of its keys.
  const keys = query instanceof UpdateQueryBuilder || query instanceof DeleteQueryBuilder ? await writeTargetKeys(query, plan.pk, max === Infinity ? undefined : max + 1) : [];
  refuseAbove(plan, keys.length, max);
  return readRows(query.Driver, plan.model, plan.table, plan.pk, plan.columns, keys);
}

/** Undefined when the rows an insert wrote cannot be known. */
async function rowsAfter(query: QueryBuilder, plan: Plan, before: ReadonlyMap<string, CapturedRow>, result: unknown): Promise<ReadonlyMap<string, CapturedRow> | undefined> {
  if (!(query instanceof InsertQueryBuilder)) return allDeleted(plan, before, result) ? new Map<string, CapturedRow>() : readRows(query.Driver, plan.model, plan.table, plan.pk, plan.columns, [...before.keys()]);
  const upsert = isUpsert(query);
  const conflicting = upsert ? await conflictingRows(query, plan) : new Map<string, CapturedRow>();
  if (upsert && everyRowConflicts(query, plan)) return conflicting;
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
    this.pending.set(query, { plan, before: await targetRows(query, plan) });
  }

  async afterQueryExecution(query: QueryBuilder, result: unknown): Promise<void> {
    const pending = this.pending.get(query);
    if (!pending) return;
    this.pending.delete(query);
    const { plan, before } = pending;
    const after = await rowsAfter(query, plan, before, result);
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
