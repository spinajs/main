import { dateTimeOf } from './brand.js';

/**
 * Milliseconds since the epoch of a valid `Date`, also one from another realm ( `instanceof Date` is false there );
 * `undefined` for an invalid Date or anything else. Reads the time through `Date.prototype.getTime`, so an own or
 * overridden `getTime` on the value is not called.
 */
export function toEpochMs(v: unknown): number | undefined {
  const t = dateTimeOf(v);
  return t === undefined || Number.isNaN(t) ? undefined : t;
}

/** Type guard for a `Date` from any realm that holds a time ( not `new Date(NaN)` ). */
export function isValidDate(v: unknown): v is Date {
  return toEpochMs(v) !== undefined;
}

export interface ParseIsoInstantOptions {
  /** Also accept a bare date ( `2030-01-02` ), read as UTC midnight. */
  dateOnly?: boolean;
}

// Date.parse takes RFC 2822 and engine-specific forms, and rolls 2026-02-30 or 24:00 over into the next month or day.
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:(Z)|([+-])(\d{2}):(\d{2})))?$/;

/**
 * Parses an ISO 8601 instant: `YYYY-MM-DDThh:mm[:ss[.fraction]]` with `Z` or a `±hh:mm` offset. Strict: a time needs
 * a zone, and every field must be in range, so `2026-02-30`, `24:00` or `:60` are refused instead of rolled over.
 * Fractions past milliseconds are truncated.
 *
 * @returns the instant, or `undefined` for any other text
 * @example
 * parseIsoInstant('2030-01-02T03:04:05.678+01:00'); // 2030-01-02T02:04:05.678Z
 * parseIsoInstant('2030-01-02T03:04:05');           // undefined: no zone
 */
export function parseIsoInstant(text: unknown, options?: ParseIsoInstantOptions): Date | undefined {
  if (typeof text !== 'string' || text.length > 40) return undefined;
  const m = ISO_INSTANT.exec(text);
  if (!m) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hasTime = m[4] !== undefined;
  if (!hasTime && options?.dateOnly !== true) return undefined;

  const at = new Date(0);
  // setUTCFullYear, not Date.UTC: Date.UTC maps years 0-99 to 1900-1999.
  at.setUTCFullYear(year, month - 1, day);
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return undefined;
  if (!hasTime) return at;

  const [hour, minute, second] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  const ms = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, '0'));
  const offsetHours = Number(m[10] ?? 0);
  const offsetMinutes = Number(m[11] ?? 0);
  if (hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) return undefined;
  const offset = (m[9] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes);
  const result = new Date(at.getTime() + ((hour * 60 + minute - offset) * 60 + second) * 1000 + ms);
  return Number.isNaN(result.getTime()) ? undefined : result;
}
