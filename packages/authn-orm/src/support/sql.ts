import { createHash } from 'node:crypto';

import { InvalidArgument, ResourceDuplicated } from '@spinajs/exceptions';
import { OrmDriver } from '@spinajs/orm';
import { _check_arg, _is_string, _non_empty } from '@spinajs/util';
import { DateTime } from 'luxon';

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

// Four-digit years keep the text form of a datetime ordered on sqlite, where the column holds text.
export const MIN_MS = Date.UTC(1000, 0, 1);
export const MAX_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** @internal The instant as a datetime column value, clamped to four-digit years. */
export function instant(ms: number): DateTime {
  return DateTime.fromMillis(Math.min(Math.max(ms, MIN_MS), MAX_MS), { zone: 'utc' });
}

/**
 * @internal {@link instant} as column text, for the migrations, which run on a bare driver: ISO-8601 on SQLite, where
 * columns hold text and compare as text, the SQL format elsewhere.
 */
export function sqlTime(ms: number, dialect: Dialect): string {
  const at = instant(ms);
  return dialect === 'sqlite' ? at.toISO()! : at.toFormat('yyyy-MM-dd HH:mm:ss.SSS');
}

/** @internal A hydrated datetime column as a Date; an invalid or missing value is an invalid Date. */
export function dateOf(value: DateTime | null | undefined): Date {
  return value ? value.toJSDate() : new Date(NaN);
}

/** @internal The time of a valid Date within four-digit years; anything else throws `InvalidArgument` naming `label`. */
export function checkedMs(value: unknown, label: string): number {
  const ms = value instanceof Date ? value.getTime() : NaN;
  if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) {
    throw new InvalidArgument(`${label} must be a valid Date`);
  }
  return ms;
}

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
  const text: string = _check_arg(_is_string(...(allowEmpty ? [] : [_non_empty()])))(value, label);
  const length = [...text].length;
  if (length > max) {
    throw new InvalidArgument(`${label} is ${length} characters long, the column holds ${max}`);
  }
  return text;
}

/** @internal Cuts to `max` code points, so no surrogate pair is split. */
export function cutText(value: string | undefined | null, max: number): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value);
  if (s.length <= max) return s;
  return [...s].slice(0, max).join('');
}
