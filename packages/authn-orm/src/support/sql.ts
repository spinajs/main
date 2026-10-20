import { createHash } from 'node:crypto';

import { InvalidArgument } from '@spinajs/exceptions';
import { _check_arg, _is_string, _non_empty } from '@spinajs/util';
import { DateTime } from 'luxon';

// Four-digit years keep the text form of a datetime ordered on sqlite, where the column holds text.
export const MIN_MS = Date.UTC(1000, 0, 1);
export const MAX_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** @internal The instant as a datetime column value, clamped to four-digit years. */
export function instant(ms: number): DateTime {
  return DateTime.fromMillis(Math.min(Math.max(ms, MIN_MS), MAX_MS), { zone: 'utc' });
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
