import { dateTimeOf } from './brand.js';
import { compareStrings } from './string.js';

export interface ICustomDataType {
  dataType: string;
  value: any;
}

/**
 * `JSON.stringify` replacer that serializes types the JSON spec drops or flattens: `Map`, `Set` and `Date` are
 * encoded as tagged objects so {@link reviver} can restore them. An invalid Date is tagged with `value: null`.
 *
 * A Date reaches a replacer already turned into a string by its `toJSON`, so the Date tag reads the raw value from
 * the holder, which `JSON.stringify` passes as `this`. Called as a plain function, it tags `Map` and `Set` only.
 */
export function replacer(this: unknown, key: string, value: unknown) {
  const raw = this !== null && typeof this === 'object' ? (this as Record<string, unknown>)[key] : value;
  const time = dateTimeOf(raw);
  if (time !== undefined) {
    return { dataType: 'Date', value: Number.isNaN(time) ? null : new Date(time).toISOString() };
  } else if (value instanceof Map) {
    return {
      dataType: 'Map',
      value: Array.from(value.entries()), // or with spread: value: [...value]
    };
  } else if (value instanceof Set) {
    return {
      dataType: 'Set',
      value: Array.from(value.values()),
    };
  } else {
    return value;
  }
}

/**
 * `JSON.parse` reviver paired with {@link replacer}: restores `Map`, `Set` and `Date` values that were
 * encoded as tagged objects.
 */
export function reviver(_: string, value: ICustomDataType) {
  if (typeof value === 'object' && value !== null) {
    if (value.dataType === 'Map') {
      return new Map(value.value);
    }
    if (value.dataType === 'Set') {
      return new Set(value.value);
    }
    if (value.dataType === 'Date') {
      return new Date(typeof value.value === 'string' ? value.value : NaN);
    }
  }
  return value;
}

/**
 * `JSON.stringify` that preserves `Map` / `Set` / `Date` via {@link replacer}.
 *
 * @param value - value to serialize
 * @param space - optional indentation ( number of spaces or string )
 * @example
 * jsonStringify({ tags: new Set(['a', 'b']) });
 */
export function jsonStringify(value: unknown, space?: string | number): string {
  return JSON.stringify(value, replacer, space);
}

/**
 * `JSON.parse` that restores `Map` / `Set` / `Date` via {@link reviver}.
 *
 * @param text - JSON text produced by {@link jsonStringify}
 */
export function jsonParse<T = unknown>(text: string): T {
  return JSON.parse(text, reviver) as T;
}

/**
 * Parses JSON, returning `fallback` instead of throwing on malformed input.
 * Uses the {@link reviver} so `Map` / `Set` / `Date` are restored on success.
 *
 * @param text - JSON text ( or any value; non-strings yield the fallback )
 * @param fallback - value returned when parsing fails
 * @example
 * safeParse<number[]>(req.query.ids, []); // never throws
 */
export function safeParse<T = unknown>(text: string, fallback: T): T {
  if (typeof text !== 'string') {
    return fallback;
  }
  try {
    return JSON.parse(text, reviver) as T;
  } catch {
    return fallback;
  }
}

/**
 * `JSON.stringify` with object keys sorted by code unit, so two objects that differ only in key order give the same
 * text: a stable input for a hash or a cache key. Array order is kept. Otherwise it follows `JSON.stringify`
 * ( `toJSON` is called, `undefined` and functions are dropped from objects and become `null` in arrays, non-finite
 * numbers become `null` ), except that a top-level value JSON cannot hold gives `'null'` instead of `undefined`.
 *
 * @throws TypeError on a cycle or a `bigint`, as `JSON.stringify` does
 * @example
 * stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }); // '{"a":[2,{"c":4,"d":3}],"b":1}'
 */
export function stableStringify(value: unknown): string {
  return writeStable(value, '', new Set()) ?? 'null';
}

function writeStable(value: unknown, key: string, path: Set<object>): string | undefined {
  let v = value;
  if ((v !== null && typeof v === 'object') || typeof v === 'bigint') {
    const toJSON = (v as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') v = toJSON.call(v, key);
  }
  if (v instanceof Number || v instanceof String || v instanceof Boolean) v = v.valueOf();
  if (v === null || typeof v !== 'object') return JSON.stringify(v);

  if (path.has(v)) throw new TypeError('stableStringify: the value holds a cycle');
  path.add(v);
  try {
    if (Array.isArray(v)) {
      return `[${v.map((x, i) => writeStable(x, String(i), path) ?? 'null').join(',')}]`;
    }
    const o = v as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(o).sort(compareStrings)) {
      const text = writeStable(o[k], k, path);
      if (text !== undefined) parts.push(`${JSON.stringify(k)}:${text}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    path.delete(v);
  }
}
