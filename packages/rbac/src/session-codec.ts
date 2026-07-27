import { DateTime } from 'luxon';
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
 * Restores a session `Data` map from a JSON string produced by
 * {@link encodeSessionData}.
 *
 * @param json - the serialized session data
 */
export function decodeSessionData(json: string): Map<string, unknown> {
  const parsed = JSON.parse(json, sessionReviver);
  return parsed instanceof Map ? (parsed as Map<string, unknown>) : new Map<string, unknown>();
}
