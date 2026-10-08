import { createHash } from 'node:crypto';

import { InvalidArgument, ResourceDuplicated } from '@spinajs/exceptions';
import { OrmDriver, RawQuery } from '@spinajs/orm';
import type { IUpdateResult } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { fromUtcColumn } from '../models/utc.js';

/** @internal */
export type Dialect = 'sqlite' | 'postgres' | 'mysql' | 'mssql' | 'other';

const DIALECT_CLASSES: readonly (readonly [string, Dialect])[] = [
  ['SqliteOrmDriver', 'sqlite'],
  ['PostgresOrmDriver', 'postgres'],
  ['MySqlOrmDriver', 'mysql'],
  ['MsSqlOrmDriver', 'mssql'],
];

/** @internal The driver's SQL dialect, from its class chain, else from the name it was registered under. */
export function driverDialect(driver: OrmDriver): Dialect {
  for (let p = Object.getPrototypeOf(driver); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    const hit = DIALECT_CLASSES.find(([name]) => p.constructor?.name === name);
    if (hit) return hit[1];
  }
  const registered = String((driver as { Options?: { Driver?: unknown } }).Options?.Driver ?? '');
  for (const d of ['sqlite', 'postgres', 'mysql', 'mssql'] as const) {
    if (registered.includes(d)) return d;
  }
  return 'other';
}

// A datetime read as text comes back exactly as stored; node-postgres would parse it in the local zone (D10).
/** @internal Undefined for an unknown dialect: read the column itself and pass it to {@link columnText}. */
export function textColumn(dialect: Dialect, column: string, alias: string): RawQuery | undefined {
  switch (dialect) {
    case 'sqlite':
    case 'postgres':
      return RawQuery.create(`CAST(${column} AS TEXT) AS ${alias}`);
    case 'mysql':
      return RawQuery.create(`CAST(${column} AS CHAR) AS ${alias}`);
    case 'mssql':
      return RawQuery.create(`CONVERT(varchar(23), ${column}, 121) AS ${alias}`);
    default:
      return undefined;
  }
}

/** @internal Adds `column` to a select, as text where the dialect allows. */
export function selectTime<Q extends { select(column: string | RawQuery): Q }>(dialect: Dialect, query: Q, column: string, alias: string): Q {
  const text = textColumn(dialect, column, alias);
  return text ? query.select(text) : query.select(column);
}

/** @internal The text form of a datetime selected with {@link selectTime}; null when the column is null. */
export function columnText(dialect: Dialect, row: Record<string, unknown>, column: string, alias: string): string | null {
  const value = textColumn(dialect, column, alias) ? row[alias] : row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && textColumn(dialect, column, alias)) return value;
  const at = fromUtcColumn(value as string | Date | DateTime);
  return at ? sqlTime(at.getTime()) : String(value);
}

// Four-digit years keep the text form of a datetime ordered on sqlite, where the column holds text.
export const MIN_MS = Date.UTC(1000, 0, 1);
export const MAX_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** @internal UTC wall-clock text in the format every store writes, clamped to four-digit years. */
export function sqlTime(ms: number): string {
  return DateTime.fromMillis(Math.min(Math.max(ms, MIN_MS), MAX_MS), { zone: 'utc' }).toFormat('yyyy-MM-dd HH:mm:ss.SSS');
}

/** @internal NaN when the text does not parse. */
export function textMs(text: string): number {
  return fromUtcColumn(text)?.getTime() ?? NaN;
}

/** @internal The time of a valid Date within four-digit years; anything else throws `InvalidArgument` naming `label`. */
export function checkedMs(value: unknown, label: string): number {
  const ms = value instanceof Date ? value.getTime() : NaN;
  if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) {
    throw new InvalidArgument(`${label} must be a valid Date`);
  }
  return ms;
}

/** @internal */
export const rowsAffected = (r: unknown): number => (r as IUpdateResult | undefined)?.RowsAffected ?? 0;

// sqlite: ResourceDuplicated; postgres: 23505; mysql: ER_DUP_ENTRY / 1062; mssql: 2627 (key) or 2601 (index).
/** @internal */
export function isDuplicate(err: unknown): boolean {
  let current = err as { code?: unknown; errno?: unknown; number?: unknown; inner?: unknown; cause?: unknown; originalError?: unknown } | undefined;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof ResourceDuplicated || current.code === '23505' || current.code === 'ER_DUP_ENTRY' || current.errno === 1062 || current.number === 2627 || current.number === 2601) {
      return true;
    }
    current = (current.inner ?? current.cause ?? current.originalError) as typeof current;
  }
  return false;
}

/** @internal Hex SHA-256 of the UTF-8 bytes. */
export const sha256hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** @internal A string of at most `max` characters (code points), or `InvalidArgument`; never truncated. */
export function checkedText(value: unknown, max: number, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new InvalidArgument(`${label} must be a non-empty string`);
  }
  const length = [...value].length;
  if (length > max) {
    throw new InvalidArgument(`${label} is ${length} characters long, the column holds ${max}`);
  }
  return value;
}

/** @internal Cuts to `max` code points, so no surrogate pair is split. */
export function cutText(value: string | undefined | null, max: number): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value);
  if (s.length <= max) return s;
  return [...s].slice(0, max).join('');
}
