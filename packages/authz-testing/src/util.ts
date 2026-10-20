import { GLOBAL, resourceKey } from '@spinajs/authz';
import type { PrincipalRef, ResourceRef } from '@spinajs/authz';

const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Dotted path over own properties only: prototype getters and inherited members read as undefined. */
export function readPath(from: unknown, path: string | readonly string[]): unknown {
  let v = from;
  for (const segment of typeof path === 'string' ? path.split('.') : path) {
    if (UNSAFE_SEGMENTS.has(segment) || v === null || typeof v !== 'object' || !Object.hasOwn(v, segment)) return undefined;
    v = (v as Record<string, unknown>)[segment];
  }
  return v;
}

export const sameRef = (a: ResourceRef, b: ResourceRef): boolean => resourceKey(a) === resourceKey(b);

export const samePrincipal = (a: PrincipalRef, b: PrincipalRef): boolean => a.type === b.type && a.id === b.id;

/** The design's default for a type no adapter or scope resolver knows (§5.6). */
export const defaultAncestors = (ref: ResourceRef): readonly ResourceRef[] => (sameRef(ref, GLOBAL) ? [GLOBAL] : [ref, GLOBAL]);

export const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** `over` wins; plain objects merge recursively, everything else is replaced. */
export function deepMerge(base: Readonly<Record<string, unknown>>, over: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}

/** Copies arrays and plain objects recursively; anything else (Date, class instance) is shared. */
export function clonePlain<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clonePlain) as unknown as T;
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clonePlain(x)])) as T;
  return v;
}

/** Freezes arrays and plain objects recursively; call it on copies (clonePlain), not on caller objects. */
export function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v) && (Array.isArray(v) || isPlainObject(v))) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
}

// Surrogates (D800-DFFF) move above E000-FFFF, so UTF-16 units sort in code point order.
const fixup = (c: number): number => (c >= 0xe000 ? c - 0x800 : c >= 0xd800 ? c + 0x2000 : c);

export function compareCodePoints(x: string, y: string): number {
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const cx = x.charCodeAt(i);
    const cy = y.charCodeAt(i);
    if (cx !== cy) return fixup(cx) - fixup(cy);
  }
  return x.length - y.length;
}
