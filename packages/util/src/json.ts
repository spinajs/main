export interface ICustomDataType {
  dataType: string;
  value: any;
}

/**
 * `JSON.stringify` replacer that serializes structural types the JSON spec drops:
 * `Map` and `Set` are encoded as tagged objects so {@link reviver} can restore them.
 */
export function replacer(_: string, value: unknown) {
  if (value instanceof Map) {
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
 * `JSON.parse` reviver paired with {@link replacer}: restores `Map` and `Set` values that were
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
  }
  return value;
}

/**
 * `JSON.stringify` that preserves `Map` / `Set` via {@link replacer}.
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
 * `JSON.parse` that restores `Map` / `Set` via {@link reviver}.
 *
 * @param text - JSON text produced by {@link jsonStringify}
 */
export function jsonParse<T = unknown>(text: string): T {
  return JSON.parse(text, reviver) as T;
}

/**
 * Parses JSON, returning `fallback` instead of throwing on malformed input.
 * Uses the {@link reviver} so `Map` / `Set` are restored on success.
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
