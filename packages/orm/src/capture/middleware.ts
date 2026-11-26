import { Configuration } from '@spinajs/configuration-common';
import { DI, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';

import { DeleteQueryBuilder, InsertQueryBuilder, UpdateQueryBuilder } from '../builders.js';
import type { QueryBuilder } from '../builders.js';
import { extractModelDescriptor } from '../descriptor.js';
import type { LiveIndex } from '../introspection.js';
import { WriteCaptureLimitExceeded, WriteCaptureRequired } from '../exceptions.js';
import { QueryMiddleware } from '../interfaces.js';
import { sqlDialectOf } from '../sql-dialect.js';
import { WriteObserver } from './contracts.js';
import type { CaptureInterest, CapturedRow, RowChange, WriteStatement } from './contracts.js';
import { captureKeyText, countKeyless, insertedKeyTexts, lockedReads, noKeys, upsertKeys, writeTargetKeyTexts } from './keys.js';
import { keylessRead, mergeReads, noReads, readRows } from './read.js';
import type { Reads } from './read.js';

interface Watch {
  readonly observer: WriteObserver;
  readonly interest: CaptureInterest;
}

interface Plan {
  readonly statement: WriteStatement;
  readonly table: string;
  readonly pk: string;
  readonly watches: readonly Watch[];
  readonly columns: readonly string[] | '*';
}

interface Pending {
  readonly plan: Plan;
  readonly before: Reads;
  /** An upsert's conflict columns, empty for any other statement; undefined when the rows of the upsert cannot be known. */
  readonly conflict: readonly string[] | undefined;
}

/** The write a builder runs, undefined for a builder that writes no model rows. */
export function writeStatementOf(query: QueryBuilder): WriteStatement | undefined {
  const model = query.Model;
  if (!model) return undefined;
  if (query instanceof InsertQueryBuilder) return { kind: 'insert', query, model };
  if (query instanceof UpdateQueryBuilder) return { kind: 'update', query, model };
  if (query instanceof DeleteQueryBuilder) return { kind: 'delete', query, model };
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

const isTableList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((name: unknown) => typeof name === 'string');

/** The value of `db.WriteCapture.Required` as table names. Anything but a list of names throws: read as "no list", it would switch the check off. */
export function requiredTables(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!isTableList(value)) throw new InvalidOperation('write capture: db.WriteCapture.Required must be a list of table names');
  return value;
}

function refuseUnobserved(statement: WriteStatement): void {
  const required = requiredTables(DI.get(Configuration)?.get<unknown>('db.WriteCapture.Required'));
  if (required.length === 0) return;
  const table = extractModelDescriptor(statement.model)?.TableName;
  if (table === undefined || !required.includes(table)) return;
  throw new WriteCaptureRequired(`write capture: ${statement.model.name} writes ${table}, a table db.WriteCapture.Required lists, and no WriteObserver takes this ${statement.kind}; load the package that observes ${table} in this process or take the table off the list`);
}

function planOf(query: QueryBuilder): Plan | undefined {
  const statement = writeStatementOf(query);
  if (!statement) return undefined;
  const watches = observers().flatMap((observer) => {
    const interest = observer.interest(statement);
    return interest ? [{ observer, interest }] : [];
  });
  if (watches.length === 0) {
    refuseUnobserved(statement);
    return undefined;
  }
  const d = extractModelDescriptor(statement.model);
  if (!d || d.PrimaryKey.length !== 1) throw new InvalidOperation(`write capture: ${statement.model.name} needs a single-column primary key, it has ${d?.PrimaryKey.length ?? 0}`);
  return { statement, table: d.TableName, pk: d.PrimaryKey[0], watches, columns: unionColumns(watches) };
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

// Keyed by the model's column list, which the ORM replaces whenever it reloads the table (a migration that touched it).
const indexCache = new WeakMap<object, Promise<LiveIndex[] | undefined>>();

function indexesOf(query: InsertQueryBuilder, plan: Plan): Promise<LiveIndex[] | undefined> {
  const read = async () => query.Driver.tableIndexes?.(plan.table);
  const key = extractModelDescriptor(plan.statement.model)?.Columns;
  if (!key) return read();
  const cached =
    indexCache.get(key) ??
    read().catch((e: unknown) => {
      indexCache.delete(key);
      throw e;
    });
  indexCache.set(key, cached);
  return cached;
}

/**
 * The column flag Unique cannot be used: PostgreSQL and MySQL set it on every member of a composite unique index.
 * Undefined when a unique index has an expression or prefix part, which no column read can match.
 */
async function uniqueKeys(query: InsertQueryBuilder, plan: Plan): Promise<string[][] | undefined> {
  const live = await indexesOf(query, plan);
  if (!live) return [...(extractModelDescriptor(plan.statement.model)?.Indexes?.values() ?? [])].filter((i) => i.unique).map((i) => i.columns);
  const unique = live.filter((i) => i.unique && !i.primary);
  return unique.some((i) => i.inexact === true) ? undefined : unique.map((i) => i.columns);
}

const searchable = (query: InsertQueryBuilder, column: string): boolean => query.getColumnValues(column).every((v) => v === null || v === undefined || captureKeyText(v) !== undefined);

// ON CONFLICT (target) conflicts on its target only, any other unique key fails the statement; MySQL's ON DUPLICATE KEY
// UPDATE compiles no target and conflicts on every unique key.
const ARBITER_GRAMMARS = new Set(['PostgresQL', 'Sqlite']);

const grammarOf = (query: InsertQueryBuilder): string | undefined => sqlDialectOf(query.Driver.constructor as abstract new (...args: never[]) => unknown)?.grammar;

const arbiterOnly = (query: InsertQueryBuilder, target: readonly string[]): boolean => target.length > 0 && !query.Replace && query.Ignore !== true && ARBITER_GRAMMARS.has(grammarOf(query) ?? '');

/**
 * What an upsert may conflict on: the primary key, every single-column unique index and its own conflict target.
 * Undefined when it may conflict on a key over several columns or with an expression or prefix part, or supplies a
 * value no key text holds (a date, bytes).
 */
async function conflictColumns(query: InsertQueryBuilder, plan: Plan): Promise<string[] | undefined> {
  const target = query.Update && grammarOf(query) !== 'MySQL' ? query.DuplicateQueryBuilder.getColumn() : [];
  const unique = arbiterOnly(query, target) ? [] : await uniqueKeys(query, plan);
  if (unique === undefined) return undefined;
  const keys = [[plan.pk], ...unique, ...(target.length > 0 ? [target] : [])];
  if (keys.some((k) => k.length !== 1)) return undefined;
  const columns = [...new Set(keys.map(([c]) => c))];
  return columns.every((c) => searchable(query, c)) ? columns : undefined;
}

/** The rows holding a value the upsert supplies for one of its conflict columns: the rows it may update or replace. */
async function conflictingRows(query: InsertQueryBuilder, plan: Plan, columns: readonly string[]): Promise<Reads> {
  const reads: Reads[] = [];
  for (const column of columns) reads.push(await readRows(query.Driver, plan.statement.model, plan.table, plan.pk, plan.columns, upsertKeys(query, column), column));
  const out = mergeReads(reads);
  refuseAbove(plan, out.rows.size + countKeyless(out.keyless), maxRows());
  return out;
}

/** Every row supplies a conflict value, so the rows the upsert wrote are found by those values after it. */
function everyRowConflicts(query: InsertQueryBuilder, columns: readonly string[]): boolean {
  const values = columns.map((c) => query.getColumnValues(c));
  return query.Values.every((_, i) => values.some((v) => captureKeyText(v.at(i)) !== undefined));
}

const STATEMENT_PHRASES: Readonly<Record<WriteStatement['kind'], string>> = { insert: 'an insert', update: 'an update', delete: 'a delete' };

function refuseAbove(plan: Plan, rows: number, max: number): void {
  if (rows > max) throw new WriteCaptureLimitExceeded(`write capture: ${STATEMENT_PHRASES[plan.statement.kind]} of ${plan.statement.model.name} reaches ${rows} rows, above db.WriteCapture.MaxRows (${max}); narrow the statement or raise the limit`);
}

async function targetRows(query: QueryBuilder, plan: Plan, conflict: readonly string[] | undefined): Promise<Reads> {
  const max = maxRows();
  if (query instanceof InsertQueryBuilder) {
    refuseAbove(plan, query.Values.length, max);
    return conflict && conflict.length > 0 ? conflictingRows(query, plan, conflict) : noReads();
  }
  // One key above the limit is enough to refuse, so a runaway statement never loads all of its keys.
  const target = query instanceof UpdateQueryBuilder || query instanceof DeleteQueryBuilder ? await writeTargetKeyTexts(query, plan.pk, max === Infinity ? undefined : max + 1) : noKeys();
  refuseAbove(plan, target.keys.length + target.keyless.length, max);
  const rows = await readRows(query.Driver, plan.statement.model, plan.table, plan.pk, plan.columns, target.keys, plan.pk, lockedReads(query.Driver));
  return mergeReads([keylessRead(target.keyless), rows]);
}

/** Undefined when the rows an insert wrote cannot be known. */
async function rowsAfter(query: QueryBuilder, { plan, before, conflict }: Pending, result: unknown): Promise<Reads | undefined> {
  const byBeforeKeys = () => readRows(query.Driver, plan.statement.model, plan.table, plan.pk, plan.columns, [...before.rows.keys()]);
  if (!(query instanceof InsertQueryBuilder)) return allDeleted(plan, before.rows, result) ? noReads() : byBeforeKeys();
  if (conflict === undefined) return undefined;
  const upsert = conflict.length > 0;
  // A row found before is read again by its key too: an update of its conflict column would hide it from the values.
  const conflicting = upsert ? mergeReads([await byBeforeKeys(), await conflictingRows(query, plan, conflict)]) : noReads();
  if (upsert && everyRowConflicts(query, conflict)) return conflicting;
  const keys = insertedKeyTexts(query, result, plan.pk);
  if (keys === undefined) return undefined;
  const inserted = await readRows(query.Driver, plan.statement.model, plan.table, plan.pk, plan.columns, keys.keys.filter((k) => !conflicting.rows.has(k)));
  return mergeReads([conflicting, keylessRead(keys.keyless), inserted]);
}

function rowsAffected(result: unknown): unknown {
  return typeof result === 'object' && result !== null && 'RowsAffected' in result ? result.RowsAffected : undefined;
}

const allDeleted = (plan: Plan, before: ReadonlyMap<string, CapturedRow>, result: unknown): boolean => plan.statement.kind === 'delete' && rowsAffected(result) === before.size;

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
    for (const w of plan.watches) await w.observer.prepare?.(plan.statement);
    const conflict = query instanceof InsertQueryBuilder && isUpsert(query) ? await conflictColumns(query, plan) : [];
    this.pending.set(query, { plan, conflict, before: await targetRows(query, plan, conflict) });
  }

  async afterQueryExecution(query: QueryBuilder, result: unknown): Promise<void> {
    const pending = this.pending.get(query);
    if (!pending) return;
    this.pending.delete(query);
    const { plan, before } = pending;
    const after = await rowsAfter(query, pending, result);
    const changes = after === undefined ? [] : changesOf(before.rows, after.rows);
    const keylessRows = after === undefined ? 0 : countKeyless([...before.keyless, ...after.keyless]);
    for (const { observer, interest } of plan.watches) {
      await observer.observe({
        ...plan.statement,
        driver: query.Driver,
        unknownKeys: after === undefined,
        keylessRows,
        rows: changes.map((c) => ({ id: c.id, before: project(c.before, plan.pk, interest.columns), after: project(c.after, plan.pk, interest.columns) })),
      });
    }
  }

  private plan(query: QueryBuilder): Plan | undefined {
    if (!this.plans.has(query)) this.plans.set(query, planOf(query) ?? null);
    return this.plans.get(query) ?? undefined;
  }
}
