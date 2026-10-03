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
 * Object-graph twin of {@link sessionReviver}: turns the same tags back into the
 * same instances, but reads a value that is ALREADY a parsed object graph
 * instead of JSON text.
 *
 * It exists because a MySQL `json` column comes back from mysql2 already parsed.
 * Re-serializing that object only to hand it straight back to `JSON.parse` would
 * be a pure waste - and passing it to the decoder untransformed is worse than
 * wasteful: the payload's top level is the tagged wrapper
 * `{ dataType: 'Map', value: [...] }`, so without this walk `parsed instanceof Map`
 * is false and the session decodes as silently EMPTY.
 *
 * Kept byte-for-byte semantically equal to the reviver:
 *
 *  - `JSON.parse` calls its reviver bottom-up (children before parents), so the
 *    walk recurses into children BEFORE inspecting the node's own tag,
 *  - the DateTime tag is checked before the shared Map/Set tags, matching
 *    {@link sessionReviver}'s order,
 *  - properties are installed with `defineProperty` so a payload carrying a
 *    literal `__proto__` key becomes an own data property (what `JSON.parse`
 *    does) rather than mutating the result's prototype.
 *
 * Values that are already live instances (`Map` / `Set` / `DateTime`) are passed
 * through untouched: a caller may legitimately hand over data that never went
 * through a database at all.
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
 * Restores a session `Data` map from whatever a store hands back for the payload
 * written by {@link encodeSessionData}.
 *
 * TWO representations reach this function, and both are legitimate:
 *
 *  - a **string** - what {@link encodeSessionData} produces, and what every
 *    text-ish column and every non-SQL store (redis, dynamodb) returns. Parsed
 *    with {@link sessionReviver}, the JSON.parse path.
 *  - an **object** - a MySQL `json` column, which mysql2 parses for us before
 *    the ORM ever sees it. Walked with {@link reviveSessionValue}: the value is
 *    already an object graph, so round-tripping it back through
 *    `JSON.stringify` + `JSON.parse` purely to reach the reviver would be
 *    pointless work on every single session read.
 *
 * Both branches are kept deliberately. `user_sessions.Data` is a `json` column
 * on fresh installs and on every install that has run the converging migration,
 * but a driver, a column type or a store that still yields a string must keep
 * decoding - and the sqlite driver used by the tests is exactly that case.
 *
 * ANYTHING ELSE THROWS. The object branch is narrowed to a real object
 * (`!== null && typeof === 'object'`) rather than being the `else` of the string
 * test, because widening the parameter to `unknown` otherwise turns `null`,
 * `undefined` and a stray number into a silently EMPTY session: every request
 * carrying that session reads as authenticated-but-anonymous, and a store that
 * started handing back the wrong shape would log out its entire user base
 * without a single error line. A missing or malformed payload is a defect in the
 * store, not a session with no data, and it is raised as one.
 *
 * @param data - the serialized session data, as string or as parsed object
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
