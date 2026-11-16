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

/** `uniqueItems: true`, as the server checks it with `jsonEqual`. A repeated '__proto__' string is a duplicate. */
export function ajvUniqueItems(items: readonly unknown[]): boolean {
  if (items.length <= 1) return true;
  // Primitives are equal exactly when SameValueZero says so, which is what a Set compares by.
  const primitives = new Set<unknown>();
  const objects: unknown[] = [];
  for (const item of items) {
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
