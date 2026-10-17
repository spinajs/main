import { InvalidArgument } from '@spinajs/exceptions';

import { RawQuery } from './builders.js';
import type { OrmDriver } from './driver.js';
import type { IWhereBuilder } from './interfaces.js';
import { IdentifierQuoter } from './quoting.js';
import type { WhereFunction } from './types.js';

export type SqlDialect = 'sqlite' | 'postgres' | 'mysql' | 'mssql' | 'other';

const DIALECT_CLASSES: readonly (readonly [string, SqlDialect])[] = [
  ['SqliteOrmDriver', 'sqlite'],
  ['PostgresOrmDriver', 'postgres'],
  ['MySqlOrmDriver', 'mysql'],
  ['MsSqlOrmDriver', 'mssql'],
];

/** The driver's SQL dialect, from its class chain, else from the name it was registered under (`orm-driver-mysql-ssh` is mysql). */
export function driverDialect(driver: OrmDriver): SqlDialect {
  for (let p = driver ? Object.getPrototypeOf(driver) : null; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    const hit = DIALECT_CLASSES.find(([name]) => p.constructor?.name === name);
    if (hit) return hit[1];
  }
  const registered = String((driver as { Options?: { Driver?: unknown } } | undefined)?.Options?.Driver ?? '');
  for (const d of ['sqlite', 'postgres', 'mysql', 'mssql'] as const) {
    if (registered.includes(d)) return d;
  }
  return 'other';
}

/** `RowsAffected` of an update, delete or insert result; 0 when the driver did not report a number, so an unknown count never reads as success. */
export function rowsAffected(result: unknown): number {
  const n = (result as { RowsAffected?: unknown } | null | undefined)?.RowsAffected;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/**
 * True when `err`, or an error it wraps (`inner`, `cause`, `originalError`), is a unique or primary key violation:
 * postgres 23505, mysql ER_DUP_ENTRY / 1062, mssql 2627 (key) or 2601 (index), sqlite "UNIQUE constraint failed".
 */
export function isUniqueViolation(err: unknown): boolean {
  let e = err as { code?: unknown; errno?: unknown; number?: unknown; message?: unknown; inner?: unknown; cause?: unknown; originalError?: unknown } | undefined;
  for (let depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    // Not ResourceDuplicated itself: the sqlite driver throws it for every constraint failure (NOT NULL, CHECK too).
    if (e.code === '23505' || e.code === 'ER_DUP_ENTRY' || e.errno === 1062 || e.number === 2627 || e.number === 2601 || /UNIQUE constraint failed/.test(String(e.message))) {
      return true;
    }
    e = (e.inner ?? e.cause ?? e.originalError) as typeof e;
  }
  return false;
}

export interface SqlFragment {
  readonly sql: string;
  readonly bindings: readonly unknown[];
}

export function isSqlFragment(value: unknown): value is SqlFragment {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as SqlFragment).sql === 'string' && Array.isArray((value as SqlFragment).bindings);
}

const TRUE: SqlFragment = Object.freeze({ sql: '1 = 1', bindings: Object.freeze([]) });
const FALSE: SqlFragment = Object.freeze({ sql: '1 = 0', bindings: Object.freeze([]) });

function template(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment {
  let text = strings[0];
  const bindings: unknown[] = [];
  values.forEach((v, i) => {
    if (isSqlFragment(v)) {
      text += v.sql;
      bindings.push(...v.bindings);
    } else if (Array.isArray(v)) {
      if (v.length === 0) throw new InvalidArgument('sql: an empty list cannot be bound, it would render `IN ()`');
      text += v.map(() => '?').join(', ');
      bindings.push(...v);
    } else {
      text += '?';
      bindings.push(v);
    }
    text += strings[i + 1];
  });
  return { sql: text, bindings };
}

function connect(parts: readonly SqlFragment[], op: 'AND' | 'OR', empty: SqlFragment): SqlFragment {
  if (parts.length === 0) return empty;
  if (parts.length === 1) return parts[0];
  return { sql: parts.map((p) => `(${p.sql})`).join(` ${op} `), bindings: parts.flatMap((p) => [...p.bindings]) };
}

/**
 * Tagged template for SQL with bindings: a nested fragment is inlined, an array becomes `?, ?, …`, any other value one `?`.
 * Identifiers are not quoted: pass them through `sql.raw`.
 */
export const sql = Object.assign(template, {
  raw: (text: string): SqlFragment => ({ sql: text, bindings: [] }),
  /** Concatenates the fragments with `separator`, nothing parenthesised. */
  join: (parts: readonly SqlFragment[], separator: string): SqlFragment => ({ sql: parts.map((p) => p.sql).join(separator), bindings: parts.flatMap((p) => [...p.bindings]) }),
  /** Each part parenthesised and ANDed; no parts is TRUE. */
  and: (parts: readonly SqlFragment[]): SqlFragment => connect(parts, 'AND', TRUE),
  /** Each part parenthesised and ORed; no parts is FALSE. */
  or: (parts: readonly SqlFragment[]): SqlFragment => connect(parts, 'OR', FALSE),
  /** `1 = 1`: portable, mssql has no boolean literals. */
  TRUE,
  /** `1 = 0`: portable, mssql has no boolean literals. */
  FALSE,
});

export function toRawQuery(fragment: SqlFragment): RawQuery {
  return RawQuery.create(fragment.sql, [...fragment.bindings]);
}

/**
 * `(groupColumn = g1 AND column IN (…)) OR (groupColumn = g2 AND column IN (…))` as one where group: a composite-key
 * `(groupColumn, column) IN` without row values, which are not portable. No values at all matches nothing.
 */
export function whereInGroups<Q extends IWhereBuilder<any>>(query: Q, groupColumn: string, column: string, groups: ReadonlyMap<unknown, readonly unknown[]>): Q {
  const entries = [...groups].filter(([, values]) => values.length > 0);
  if (entries.length === 0) return query.where(toRawQuery(FALSE));
  return query.where(function (this: IWhereBuilder<unknown>) {
    entries.forEach(([group, values], i) => {
      const clause = function (this: IWhereBuilder<unknown>) {
        this.where(groupColumn, group).whereIn(column, [...values]);
      };
      if (i === 0) this.where(clause);
      else this.orWhere(clause);
    });
  });
}

/** MSSQL takes at most 2100 parameters per statement (some go to the driver) and 1000 rows per `VALUES`. */
const MAX_PARAMETERS = 2000;
const MAX_VALUES_ROWS = 1000;

/** Ids per `IN` list that stay under every driver's parameter limit. */
export const IN_CHUNK = 1000;

function chunks<T>(list: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new InvalidArgument(`chunk size must be a positive integer, got ${String(size)}`);
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Inserts `rows` with as few statements as the parameter limits allow, in order; returns the rows inserted.
 * The default rows per statement come from the widest row; pass `rowsPerStatement` to override.
 */
export async function insertChunked(driver: OrmDriver, table: string, rows: readonly object[], rowsPerStatement?: number): Promise<number> {
  if (rows.length === 0) return 0;
  const columns = Math.max(1, ...rows.map((r) => Object.keys(r).length));
  const size = rowsPerStatement ?? Math.min(MAX_VALUES_ROWS, Math.max(1, Math.floor(MAX_PARAMETERS / columns)));
  let count = 0;
  for (const part of chunks(rows, size))
    count += rowsAffected(
      await driver
        .insert()
        .into(table)
        .values(part as object[]),
    );
  return count;
}

export interface DeleteChunkedOptions {
  /** Extra condition every delete also checks. */
  readonly where?: WhereFunction<unknown>;
  /** Values per statement; default {@link IN_CHUNK}. */
  readonly size?: number;
}

/** `DELETE FROM table WHERE column IN (…)` over `values`, one statement per chunk; returns the rows deleted. */
export async function deleteChunked(driver: OrmDriver, table: string, column: string, values: readonly unknown[], options: DeleteChunkedOptions = {}): Promise<number> {
  let count = 0;
  for (const part of chunks(values, options.size ?? IN_CHUNK)) {
    const q = driver.del().from(table).whereIn(column, part);
    if (options.where) q.where(options.where);
    count += rowsAffected(await q);
  }
  return count;
}

export interface PurgeBatchOptions {
  readonly table: string;
  /** A unique column: the batch is selected by it, ordered by it, and deleted by it. */
  readonly key: string;
  /** The rows to purge; checked again by the delete, so a row that stopped matching in between stays. */
  readonly where: WhereFunction<unknown>;
  /** Default 500. */
  readonly limit?: number;
}

/** Deletes up to one batch of the rows `where` matches; returns how many went. */
export async function purgeBatch(driver: OrmDriver, options: PurgeBatchOptions): Promise<number> {
  const { table, key, where } = options;
  // MSSQL pages with OFFSET … FETCH, which needs an ORDER BY.
  const rows = (await driver
    .select()
    .from(table)
    .select(key)
    .where(where)
    .orderBy(key)
    .take(options.limit ?? 500)) as Record<string, unknown>[];
  if (rows.length === 0) return 0;
  return rowsAffected(
    await driver
      .del()
      .from(table)
      .whereIn(
        key,
        rows.map((r) => r[key]),
      )
      .where(where),
  );
}

/** A counter that is true on every `n`-th call, e.g. to purge stale rows now and then from a hot path. */
export function everyNthCall(n: number): () => boolean {
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgument(`everyNthCall: n must be a positive integer, got ${String(n)}`);
  let calls = 0;
  return () => {
    calls = (calls + 1) % n;
    return calls === 0;
  };
}

/**
 * `column = column + 1` on the row of `table` matching `key`, creating it at 0 first.
 * The increment is one statement, so concurrent bumps never lose a count. Run it inside the caller's transaction.
 */
export async function bumpVersionRow(driver: OrmDriver, table: string, key: Readonly<Record<string, unknown>>, column = 'version'): Promise<void> {
  const names = Object.keys(key);
  if (names.length === 0) throw new InvalidArgument('bumpVersionRow: key must name at least one column');
  await driver
    .insert()
    .into(table)
    .values({ ...key, [column]: 0 })
    .orIgnore();

  // The update builder cannot express `column = column + 1`.
  const q = driver.Container.resolve(IdentifierQuoter);
  const target = q.quote(column);
  const where = names.map((n) => `${q.quote(n)} = ?`).join(' AND ');
  await driver.schema().raw(
    `UPDATE ${q.quoteQualified(table)} SET ${target} = ${target} + 1 WHERE ${where}`,
    names.map((n) => key[n]),
  );
}
