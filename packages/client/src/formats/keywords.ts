/*
 * Ports of the Ajv 8 checks for minLength/maxLength (runtime/ucs2length.ts), multipleOf, uniqueItems, and of
 * fast-deep-equal 3.1.3, which Ajv uses for const, enum and uniqueItems.
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

function arraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = a.length; i-- !== 0; ) {
    if (!ajvEqual(a[i], b[i])) return false;
  }
  return true;
}

function objectsEqual(a: object, b: object): boolean {
  if (a.constructor !== b.constructor) return false;
  if (Array.isArray(a)) return arraysEqual(a, b as unknown[]);
  if (a.constructor === RegExp) return (a as RegExp).source === (b as RegExp).source && (a as RegExp).flags === (b as RegExp).flags;
  if (a.valueOf !== Object.prototype.valueOf) return a.valueOf() === b.valueOf();
  if (a.toString !== Object.prototype.toString) return (a as { toString(): string }).toString() === (b as { toString(): string }).toString();
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  if (!keys.every((key) => Object.prototype.hasOwnProperty.call(b, key))) return false;
  return keys.every((key) => ajvEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * Deep equality as Ajv decides `const`, `enum` and `uniqueItems`: 0 equals -0, NaN equals NaN, key order is ignored.
 * Pass the data first: like Ajv, it throws a TypeError when the first object has an own `valueOf` or `toString` key
 * that is not a function.
 */
export function ajvEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') return objectsEqual(a, b);
  return Number.isNaN(a) && Number.isNaN(b);
}

function uniqueByHash(items: readonly unknown[], itemTypes: readonly JsonType[]): boolean {
  // A plain object, as in Ajv's generated code: a '__proto__' key never registers, so repeats of it pass.
  const indices: Record<string, unknown> = {};
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
 * `uniqueItems: true`. Pass `itemTypes`, the `type` of the array's `items` schema, to take Ajv's hashing path for
 * scalar items, which differs from deep equality for repeated '__proto__' strings.
 */
export function ajvUniqueItems(items: readonly unknown[], itemTypes: readonly JsonType[] = []): boolean {
  if (items.length <= 1) return true;
  const hashable = itemTypes.length > 0 && !itemTypes.some((type) => type === 'object' || type === 'array');
  return hashable ? uniqueByHash(items, itemTypes) : uniqueByEqual(items);
}
