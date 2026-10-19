import { createHash } from 'node:crypto';

import { InvalidArgument } from '@spinajs/exceptions';
import { OrmDriver, RawQuery, SqlExpressions } from '@spinajs/orm';
import type { IUpdateResult } from '@spinajs/orm';
import { _check_arg, _is_string, _non_empty, truncate } from '@spinajs/util';
import { DateTime } from 'luxon';

import { fromUtcColumn } from '../models/utc.js';

/** @internal Adds `column` to a select as `alias`, the wall-clock text it stores; read it back with {@link columnText}. */
export function selectTime<Q extends { select(column: string | RawQuery): Q }>(driver: OrmDriver, query: Q, column: string, alias: string): Q {
  // As text: node-postgres and tedious would read the column as an instant in some zone (D10).
  return query.select(RawQuery.create(`${driver.Container.resolve(SqlExpressions).datetimeText(column)} AS ${alias}`));
}

/** @internal The text a {@link selectTime} alias holds; null when the column is null. */
export function columnText(row: Record<string, unknown>, alias: string): string | null {
  const value = row[alias];
  return value === null || value === undefined ? null : String(value);
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
  return truncate(String(value), max, '', { codePoints: true });
}
