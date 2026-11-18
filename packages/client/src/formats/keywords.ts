/*!
 * Ports of the Ajv 8 checks for minLength/maxLength (runtime/ucs2length.ts) and multipleOf.
 * ajv: MIT License, Copyright (c) 2015-2021 Evgeny Poberezkin. The full notice is in ajv-formats.ts.
 */
import { jsonEqual } from './equal.js';

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

/**
 * Deep equality as the server decides `const` and `enum` (see `jsonEqual`): 0 equals -0, NaN equals NaN, key order is
 * ignored, and an own `valueOf` or `toString` key is compared as data. Stock Ajv throws a TypeError there instead.
 */
export function ajvEqual(a: unknown, b: unknown): boolean {
  return jsonEqual(a, b);
}

/**
 * `uniqueItems: true`, as the server checks it with `jsonEqual`. A repeated '__proto__' string is a duplicate.
 * `types` are the primitive types of the `items` schema: like Ajv, only the items of those types are compared, so a
 * non-finite number a coercion left in the array is skipped.
 */
export function ajvUniqueItems(items: readonly unknown[], types?: readonly string[]): boolean {
  if (items.length <= 1) return true;
  // Primitives are equal exactly when SameValueZero says so, which is what a Set compares by.
  const primitives = new Set<unknown>();
  const objects: unknown[] = [];
  for (const item of items) {
    if (types && !types.some((t) => isOfType(t, item))) continue;
    if (item !== null && typeof item === 'object') objects.push(item);
    else if (primitives.has(item)) return false;
    else primitives.add(item);
  }
  for (let i = objects.length; i--; ) {
    for (let j = i; j--; ) {
      if (jsonEqual(objects[i], objects[j])) return false;
    }
  }
  return true;
}

function isOfType(type: string, item: unknown): boolean {
  switch (type) {
    case 'number':
      return typeof item === 'number' && Number.isFinite(item);
    case 'integer':
      return typeof item === 'number' && Number.isInteger(item);
    case 'null':
      return item === null;
    default:
      return typeof item === type;
  }
}

/**
 * ajv-keywords' `uniqueItemProperties: keys`, with the server's `jsonEqual`. `scalar[k]` tells whether the `items`
 * schema types `keys[k]` as a scalar, as ajv-keywords reads it; only object items are compared.
 */
export function uniqueItemProperties(keys: readonly string[], scalar: readonly boolean[]): (items: readonly unknown[]) => boolean {
  return (items) => items.length <= 1 || keys.every((key, k) => (scalar[k] ? scalarsUnique(items, key) : valuesUnique(items, key)));
}

function scalarsUnique(items: readonly unknown[], key: string): boolean {
  const seen = new Set<unknown>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    let value = (item as Record<string, unknown>)[key];
    if (value && typeof value === 'object') continue;
    if (typeof value === 'string') value = `"${value}`;
    if (seen.has(value)) return false;
    seen.add(value);
  }
  return true;
}

function valuesUnique(items: readonly unknown[], key: string): boolean {
  const values = items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object').map((item) => item[key]);
  for (let i = values.length; i--; ) {
    for (let j = i; j--; ) {
      if (jsonEqual(values[i], values[j])) return false;
    }
  }
  return true;
}

/**
 * Whether no number in `value` is NaN or infinite, as the server refuses one wherever it sits. Built for the
 * intersection of two schemas that both pass a NaN through: zod cannot merge two NaN and throws.
 */
export function ajvFinite(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length !== 0) {
    const item = pending.pop();
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return false;
    } else if (typeof item === 'object' && item !== null && !seen.has(item)) {
      seen.add(item);
      for (const child of Object.values(item)) pending.push(child);
    }
  }
  return true;
}

/**
 * The check of an own `__proto__` key against the `additionalProperties` schema: Ajv counts the key, and zod's object
 * parse drops it before the catchall sees it.
 */
export function ownProtoAccepted(accepts: (value: unknown) => boolean): (value: unknown) => boolean {
  return (value) => typeof value !== 'object' || value === null || Array.isArray(value) || !Object.hasOwn(value, '__proto__') || accepts(Object.getOwnPropertyDescriptor(value, '__proto__')?.value);
}
