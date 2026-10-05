import { types } from 'node:util';

import type { ResourceFilter } from '@spinajs/authz';

/** Objects plus own keys one comparison may visit; past it the filters count as different. */
const MAX_WORK = 10_000;
const MAX_DEPTH = 64;

class OverBudget extends Error {}

interface Budget {
  left: number;
}

const charge = (b: Budget, n: number): void => {
  b.left -= n;
  if (b.left < 0) throw new OverBudget();
};

// Objects with internal slots: their own keys say nothing about what they hold.
const EXOTIC: ReadonlyArray<(v: object) => boolean> = [types.isMap, types.isSet, types.isWeakMap, types.isWeakSet, types.isBoxedPrimitive, types.isAnyArrayBuffer, types.isArrayBufferView, types.isPromise, types.isRegExp, types.isNativeError, types.isGeneratorObject, types.isMapIterator, types.isSetIterator, types.isModuleNamespaceObject, types.isArgumentsObject];

/**
 * Whether two filters are the same tree (RFC C3-1), so they select the same rows. Strict: operands
 * compare in order; values (and `native:*` args) compare as primitives by `Object.is`, real Dates by
 * time, and arrays and plain objects by their own enumerable data properties, with equal key sets
 * (`{ x: undefined }` is not `{}`). Anything else (proxies, Map, Set, boxed primitives, typed arrays,
 * functions, class instances, symbol keys, accessors, holes) is the same only as the same reference.
 * Over the work budget, or on a throw, it answers false.
 */
export function sameFilter(a: ResourceFilter, b: ResourceFilter): boolean {
  try {
    return same(a, b, { left: MAX_WORK }, 0);
  } catch {
    return false;
  }
}

type Kind = 'date' | 'array' | 'object';

function kind(v: object): Kind | undefined {
  if (types.isProxy(v)) return undefined;
  const proto: unknown = Object.getPrototypeOf(v);
  if (types.isDate(v)) return proto === Date.prototype ? 'date' : undefined;
  if (Array.isArray(v)) return proto === Array.prototype ? 'array' : undefined;
  if (proto !== Object.prototype && proto !== null) return undefined;
  return EXOTIC.some((is) => is(v)) ? undefined : 'object';
}

function same(x: unknown, y: unknown, b: Budget, depth: number): boolean {
  if (Object.is(x, y)) return true;
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
  if (depth > MAX_DEPTH) return false;
  charge(b, 1);
  const k = kind(x);
  if (k === undefined || k !== kind(y) || Object.getPrototypeOf(x) !== Object.getPrototypeOf(y)) return false;
  if (k === 'date') return Reflect.ownKeys(x).length === 0 && Reflect.ownKeys(y).length === 0 && Object.is((x as Date).getTime(), (y as Date).getTime());
  if (k === 'array') return sameArray(x as unknown[], y as unknown[], b, depth);
  const keys = Reflect.ownKeys(x);
  charge(b, keys.length);
  if (Reflect.ownKeys(y).length !== keys.length) return false;
  // Equal counts plus every key of x on y means equal key sets.
  return keys.every((key) => typeof key === 'string' && sameProperty(x, y, key, b, depth));
}

function sameArray(x: unknown[], y: unknown[], b: Budget, depth: number): boolean {
  const length: unknown = Reflect.getOwnPropertyDescriptor(x, 'length')?.value;
  if (typeof length !== 'number' || Reflect.getOwnPropertyDescriptor(y, 'length')?.value !== length) return false;
  charge(b, length);
  // length + 1 own keys with every index present rules out holes and extra keys.
  if (Reflect.ownKeys(x).length !== length + 1 || Reflect.ownKeys(y).length !== length + 1) return false;
  for (let i = 0; i < length; i++) {
    if (!sameProperty(x, y, String(i), b, depth)) return false;
  }
  return true;
}

// Each value is read once from its descriptor, so a getter cannot answer differently later in the walk.
function sameProperty(x: object, y: object, key: string, b: Budget, depth: number): boolean {
  const dx = Object.getOwnPropertyDescriptor(x, key);
  const dy = Object.getOwnPropertyDescriptor(y, key);
  if (!dx || !dy || !('value' in dx) || !('value' in dy) || !dx.enumerable || !dy.enumerable) return false;
  return same(dx.value, dy.value, b, depth + 1);
}
