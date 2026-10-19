import { DateTime } from 'luxon';
import { InvalidArgument } from '@spinajs/exceptions';
import { replacer as baseReplacer, reviver as baseReviver, ICustomDataType } from '@spinajs/util';

/**
 * Shared session-data serialization codec (fixes B5 — symmetric write/read).
 *
 * Persistent session stores (db / dynamodb / redis) use this pair so the
 * `replacer` used on write and the `reviver` used on read are symmetric and
 * structural types survive the round-trip:
 *  - `Map` / `Set` via the shared @spinajs/util replacer/reviver,
 *  - luxon `DateTime` via a tagged wrapper.
 *
 * The in-memory store keeps live objects and does not use this codec.
 */

const DATETIME_TAG = 'DateTime';

/**
 * `JSON.stringify` replacer. Must read the RAW value from the holder (`this`)
 * because luxon's `DateTime.prototype.toJSON` would otherwise stringify the
 * DateTime to an ISO string before we can tag it.
 */
function sessionReplacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const raw = this[key];
  if (raw instanceof DateTime) {
    return { dataType: DATETIME_TAG, value: raw.toISO() };
  }
  return baseReplacer(key, value);
}

/**
 * `JSON.parse` reviver paired with {@link sessionReplacer}.
 */
function sessionReviver(key: string, value: ICustomDataType | unknown): unknown {
  if (value && typeof value === 'object' && (value as ICustomDataType).dataType === DATETIME_TAG) {
    return DateTime.fromISO((value as ICustomDataType).value as string);
  }
  return baseReviver(key, value as ICustomDataType);
}

const MAP_TAG = 'Map';
const SET_TAG = 'Set';

/**
 * {@link sessionReviver} for an already-parsed object graph (a MySQL `json` column comes back parsed), walked bottom-up
 * like `JSON.parse`; `defineProperty` keeps a literal `__proto__` key an own property. Live Map/Set/DateTime pass through.
 */
function reviveSessionValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(reviveSessionValue);
  }

  // already-materialized structural types - nothing to rebuild
  if (value instanceof Map || value instanceof Set || DateTime.isDateTime(value)) {
    return value;
  }

  const tag = (value as ICustomDataType).dataType;

  if (tag === DATETIME_TAG) {
    return DateTime.fromISO((value as ICustomDataType).value as string);
  }

  if (tag === MAP_TAG) {
    const entries = ((value as ICustomDataType).value ?? []) as [unknown, unknown][];
    return new Map(entries.map(([k, v]) => [reviveSessionValue(k), reviveSessionValue(v)] as [unknown, unknown]));
  }

  if (tag === SET_TAG) {
    const members = ((value as ICustomDataType).value ?? []) as unknown[];
    return new Set(members.map(reviveSessionValue));
  }

  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    Object.defineProperty(out, k, {
      value: reviveSessionValue(v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return out;
}

/**
 * Serializes a session `Data` map to a JSON string, preserving `Map` / `Set` /
 * `DateTime` values.
 *
 * @param data - the session data map
 */
export function encodeSessionData(data: Map<string, unknown>): string {
  return JSON.stringify({ dataType: 'Map', value: Array.from(data.entries()) }, sessionReplacer);
}

/**
 * Restores a session `Data` map from a JSON string or an already-parsed object (a MySQL `json` column). Anything else
 * is a store defect and throws, rather than decoding as an empty, anonymous session.
 *
 * @throws `InvalidArgument` when `data` is neither a string nor a non-null object
 */
export function decodeSessionData(data: string | unknown): Map<string, unknown> {
  if (typeof data === 'string') {
    const parsed = JSON.parse(data, sessionReviver);

    return parsed instanceof Map ? (parsed as Map<string, unknown>) : new Map<string, unknown>();
  }

  if (data !== null && typeof data === 'object') {
    const revived = reviveSessionValue(data);

    return revived instanceof Map ? (revived as Map<string, unknown>) : new Map<string, unknown>();
  }

  throw new InvalidArgument(`Cannot decode session data: expected a JSON string or an already-parsed object, got ${data === null ? 'null' : typeof data}`, 'data');
}
