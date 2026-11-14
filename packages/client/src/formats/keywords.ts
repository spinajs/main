/*!
 * Ports of the Ajv 8 checks for minLength/maxLength (runtime/ucs2length.ts), multipleOf and uniqueItems, and of the
 * fast-deep-equal 3.1.3 variant @spinajs/validation compares const, enum and uniqueItems with.
 * ajv: MIT License, Copyright (c) 2015-2021 Evgeny Poberezkin. fast-deep-equal: MIT License, Copyright (c) 2017
 * Evgeny Poberezkin. The full notice is in ajv-formats.ts.
 */
import { checkDataTypes, type JsonType } from './data-type.js';

/** Length in code points, as Ajv counts it: a lone surrogate counts as one. */
function ucs2length(str: string): number {
  const len = str.length;
  let length = 0;
  let pos = 0;
  while (pos < len) {
    length++;
    const value = str.charCodeAt(pos++);
    if (value >= 0xd800 && value <= 0xdbff && pos < len && (str.charCodeAt(pos) & 0xfc00) === 0xdc00) {
      pos++;
    }
  }
  return length;
}

export function minCodePoints(n: number): (str: string) => boolean {
  return (str) => ucs2length(str) >= n;
}

export function maxCodePoints(n: number): (str: string) => boolean {
  return (str) => ucs2length(str) <= n;
}

/** Ajv's own test, `parseInt(value / n)`, so a quotient of 1e21 or more fails, as on the server. */
export function ajvMultipleOf(n: number): (value: number) => boolean {
  return (value) => {
    if (n === 0) return false;
    const quotient = value / n;
    return quotient === parseInt(String(quotient));
  };
}

function objectsEqual(a: object, b: object): boolean {
  const proto = Object.getPrototypeOf(a) as object | null;
  if (proto !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    if (a.length !== other.length) return false;
    for (let i = a.length; i-- !== 0; ) {
      if (!ajvEqual(a[i], other[i])) return false;
    }
    return true;
  }
  if (a instanceof RegExp) return a.source === (b as RegExp).source && a.flags === (b as RegExp).flags;
  if (proto !== null && proto !== Object.prototype) {
    // Only a prototype's own comparison is used: a `valueOf` or `toString` key on the value itself is data.
    const { valueOf, toString } = proto as { valueOf?: unknown; toString?: unknown };
    if (typeof valueOf === 'function' && valueOf !== Object.prototype.valueOf) return valueOf.call(a) === valueOf.call(b);
    if (typeof toString === 'function' && toString !== Object.prototype.toString) return toString.call(a) === toString.call(b);
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (let i = keys.length; i-- !== 0; ) {
    if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
  }
  for (let i = keys.length; i-- !== 0; ) {
    if (!ajvEqual((a as Record<string, unknown>)[keys[i]], (b as Record<string, unknown>)[keys[i]])) return false;
  }
  return true;
}

/**
 * Deep equality as the server decides `const`, `enum` and `uniqueItems`: 0 equals -0, NaN equals NaN, key order is
 * ignored. A plain object is compared by its own keys, so `{"valueOf":1}` is data and never throws.
 */
export function ajvEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') return objectsEqual(a, b);
  return Number.isNaN(a) && Number.isNaN(b);
}
function uniqueByHash(items: readonly unknown[], itemTypes: readonly JsonType[]): boolean {
  // No prototype, as on the server: a repeated '__proto__' item is a duplicate like any other.
  const indices: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (let i = items.length; i--; ) {
    let item = items[i];
    if (checkDataTypes(itemTypes, item, false)) continue;
    if (itemTypes.length > 1 && typeof item === 'string') item += '_';
    const key = String(item);
    if (typeof indices[key] === 'number') return false;
    indices[key] = i;
  }
  return true;
}

function uniqueByEqual(items: readonly unknown[]): boolean {
  for (let i = items.length; i--; ) {
    for (let j = i; j--; ) {
      if (ajvEqual(items[i], items[j])) return false;
    }
  }
  return true;
}

/**
 * `uniqueItems: true`. `itemTypes` is what Ajv's `getSchemaTypes(parentSchema.items)` reads: the literal `type` of
 * the `items` node, with `null` added for `nullable: true`. When `items` is absent, a tuple array, or has no `type`
 * of its own (`$ref`, `anyOf`), Ajv reads `[]`: pass nothing. With only scalar types the items are hashed, and items of
 * another type are skipped: `items` reports them.
 */
export function ajvUniqueItems(items: readonly unknown[], itemTypes: readonly JsonType[] = []): boolean {
  if (items.length <= 1) return true;
  const hashable = itemTypes.length > 0 && !itemTypes.some((type) => type === 'object' || type === 'array');
  return hashable ? uniqueByHash(items, itemTypes) : uniqueByEqual(items);
}
