import { dateTimeOf, hasInternalSlots } from './brand.js';

/**
 * Type guard for non-null objects that are not arrays. Class instances match too.
 *
 * @param v - value to test
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Freezes `v` and everything reachable through its own enumerable properties, in place, including the children of nodes that are already frozen. Buffers and typed arrays are left mutable, as `Object.freeze` refuses them.
 *
 * @param v - value to freeze
 * @param options - `skipDates: true` leaves `Date`s ( and their own properties ) unfrozen; freezing a Date does not stop `setTime` anyway
 * @returns `v`
 */
export function deepFreeze<T>(v: T, options?: { skipDates?: boolean }): Readonly<T> {
  freezeAll(v, new WeakSet(), options?.skipDates === true);
  return v;
}

function freezeAll(v: unknown, seen: WeakSet<object>, skipDates: boolean): void {
  if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v) || seen.has(v)) return;
  if (skipDates && dateTimeOf(v) !== undefined) return;
  seen.add(v);
  Object.freeze(v);
  for (const x of Object.values(v)) freezeAll(x, seen, skipDates);
}

/**
 * Deep clone of `v` that is frozen, for plain data: arrays, `Date`s and the own enumerable properties of any other object. A `Map`, `Set`, typed array or class instance becomes a plain object of its own enumerable properties (a `Map` or `Set` becomes `{}`), so the `Readonly<T>` type holds for plain data only.
 *
 * `Date`s are cloned and their setters throw, as a frozen `Date` can still be changed with `setTime`. This blocks accidental mutation only: `Date.prototype.setTime.call` still bypasses it.
 *
 * @param v - value to copy
 * @param maxDepth - values nested deeper than this become `undefined`
 */
export function frozenCopy<T>(v: T, maxDepth = 16): Readonly<T> {
  return copyFrozen(v, maxDepth, 0) as Readonly<T>;
}

const DATE_SETTERS = Object.getOwnPropertyNames(Date.prototype).filter((n) => n.startsWith('set'));

function immutableDate(time: number): Date {
  const d = new Date(time);
  for (const name of DATE_SETTERS) {
    Object.defineProperty(d, name, {
      value: () => {
        throw new TypeError('Cannot modify a frozen Date');
      },
    });
  }
  return Object.freeze(d);
}

function copyFrozen(v: unknown, maxDepth: number, depth: number): unknown {
  if (depth > maxDepth) return undefined;
  if (v instanceof Date) return immutableDate(v.getTime());
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return Object.freeze(v.map((x) => copyFrozen(x, maxDepth, depth + 1)));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = copyFrozen(x, maxDepth, depth + 1);
  return Object.freeze(out);
}

type Obj = Record<string, unknown>;

/** Type guard for objects whose prototype is `Object.prototype` or `null`: no arrays, no class instances. */
export function isStrictPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Keys that reach or replace a prototype when assigned or read through a path. */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

export function isUnsafeKey(key: PropertyKey): boolean {
  return typeof key === 'string' && UNSAFE_KEYS.has(key);
}

/** Sets an own enumerable, writable data property. Unlike assignment it never runs an inherited setter, so `__proto__` becomes a plain key. */
export function defineOwn(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Reads a dotted path ( or a list of segments ) over own properties only. Inherited members, a non-object on the way
 * and any {@link UNSAFE_KEYS} segment read as `undefined`.
 *
 * @example
 * getOwnPath({ a: { b: 1 } }, 'a.b'); // 1
 * getOwnPath({}, 'constructor.name'); // undefined
 */
export function getOwnPath(from: unknown, path: string | readonly string[]): unknown {
  let v = from;
  for (const segment of typeof path === 'string' ? path.split('.') : path) {
    if (UNSAFE_KEYS.has(segment) || v === null || typeof v !== 'object' || !Object.hasOwn(v, segment)) return undefined;
    v = (v as Obj)[segment];
  }
  return v;
}

export interface CopyPlainDataOptions {
  /** Objects and arrays may nest this many levels below the root ( default 32 ). */
  maxDepth?: number;
  /** Object keys plus array elements the copy may visit in all ( default 10 000 ); shared subtrees count each time. */
  maxValues?: number;
}

interface CopyWalk {
  readonly path: Set<object>;
  readonly maxDepth: number;
  left: number;
}

/**
 * Deep copy of plain data: primitives, arrays, `Date`s ( any realm ) and objects with a `null` or `Object.prototype`
 * prototype. {@link UNSAFE_KEYS} are dropped and null-prototype objects come back with `Object.prototype`.
 *
 * @throws TypeError on a cycle, a function, a symbol, or an object that is not plain data ( Map, class instance ... )
 * @throws RangeError past `maxDepth` or `maxValues`
 */
export function copyPlainData<T>(v: T, options?: CopyPlainDataOptions): T {
  return copyData(v, 0, { path: new Set(), maxDepth: options?.maxDepth ?? 32, left: options?.maxValues ?? 10_000 }) as T;
}

function copyData(v: unknown, depth: number, walk: CopyWalk): unknown {
  if (typeof v === 'function' || typeof v === 'symbol') throw new TypeError(`copyPlainData: a ${typeof v} is not plain data`);
  if (v === null || typeof v !== 'object') return v;
  const time = dateTimeOf(v);
  if (time !== undefined) return new Date(time);
  const isArray = Array.isArray(v);
  if (!isArray && (!isStrictPlainObject(v) || hasInternalSlots(v))) throw new TypeError('copyPlainData: the value holds an object that is not plain data');
  if (depth > walk.maxDepth) throw new RangeError(`copyPlainData: the value is nested deeper than ${walk.maxDepth}`);
  if (walk.path.has(v)) throw new TypeError('copyPlainData: the value holds a cycle');
  walk.path.add(v);
  try {
    if (isArray) {
      const list = v as unknown[];
      const length = list.length;
      spend(walk, length);
      const out: unknown[] = [];
      for (let i = 0; i < length; i++) out.push(copyData(list[i], depth + 1, walk));
      return out;
    }
    const keys = Object.keys(v);
    spend(walk, keys.length);
    const out: Obj = {};
    for (const k of keys) {
      if (!UNSAFE_KEYS.has(k)) defineOwn(out, k, copyData((v as Obj)[k], depth + 1, walk));
    }
    return out;
  } finally {
    walk.path.delete(v);
  }
}

function spend(walk: CopyWalk, n: number): void {
  if (n > walk.left) throw new RangeError('copyPlainData: the value holds more values than maxValues');
  walk.left -= n;
}

export interface DeepEqualOptions {
  /** Objects plus own keys one comparison may visit ( default 10 000 ); past it the values count as different. */
  maxWork?: number;
  /** Nesting past this depth ( default 64 ) counts as different. */
  maxDepth?: number;
}

class OverBudget extends Error {}

interface Budget {
  left: number;
  readonly maxDepth: number;
}

/**
 * Structural equality of plain data, bounded so a hostile value cannot stall it. Primitives compare by `Object.is`
 * ( `0` and `-0` differ, `NaN` equals `NaN` ), Dates by time, arrays and plain objects by their own enumerable data
 * properties with equal key sets ( `{ x: undefined }` is not `{}` ), and both sides must share a prototype.
 * Anything else ( Map, Set, boxed primitives, typed arrays, class instances, symbol keys, accessors, array holes )
 * is equal only as the same reference. Values are read through descriptors, so getters do not run, but a Proxy is
 * read through its traps.
 * Over `maxWork`, past `maxDepth`, or on a throw, it answers `false`.
 */
export function deepEqual(a: unknown, b: unknown, options?: DeepEqualOptions): boolean {
  try {
    return same(a, b, { left: options?.maxWork ?? 10_000, maxDepth: options?.maxDepth ?? 64 }, 0);
  } catch {
    return false;
  }
}

type Kind = 'date' | 'array' | 'object';

function kindOf(v: object): Kind | undefined {
  if (dateTimeOf(v) !== undefined) return 'date';
  if (Array.isArray(v)) return 'array';
  if (!isStrictPlainObject(v)) return undefined;
  return hasInternalSlots(v) ? undefined : 'object';
}

function charge(b: Budget, n: number): void {
  b.left -= n;
  if (b.left < 0) throw new OverBudget();
}

function same(x: unknown, y: unknown, b: Budget, depth: number): boolean {
  if (Object.is(x, y)) return true;
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
  if (depth > b.maxDepth) return false;
  charge(b, 1);
  const k = kindOf(x);
  if (k === undefined || k !== kindOf(y) || Object.getPrototypeOf(x) !== Object.getPrototypeOf(y)) return false;
  if (k === 'date') return Reflect.ownKeys(x).length === 0 && Reflect.ownKeys(y).length === 0 && Object.is(dateTimeOf(x), dateTimeOf(y));
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

// Descriptors, not `x[key]`, so no getter runs.
function sameProperty(x: object, y: object, key: string, b: Budget, depth: number): boolean {
  const dx = Object.getOwnPropertyDescriptor(x, key);
  const dy = Object.getOwnPropertyDescriptor(y, key);
  if (!dx || !dy || !('value' in dx) || !('value' in dy) || !dx.enumerable || !dy.enumerable) return false;
  return same(dx.value, dy.value, b, depth + 1);
}

export interface DeepMergeOptions {
  /** `replace` ( default ): an array in `over` replaces the base one. `concat`: base items, then `over` items, as configuration files merge. */
  arrays?: 'replace' | 'concat';
}

/**
 * Merges `over` onto `base` into a new object; neither input is changed and the result shares no array or plain
 * object with them. Plain objects ( see {@link isStrictPlainObject} ) merge recursively, `undefined` in `over` keeps
 * the base value, anything else in `over` replaces it. Class instances, Dates and Maps are kept by reference.
 * {@link UNSAFE_KEYS} are dropped.
 *
 * @throws TypeError when an input is not a plain object or holds a cycle
 * @example
 * deepMerge({ db: { host: 'a', port: 1 } }, { db: { port: 2 } }); // { db: { host: 'a', port: 2 } }
 */
export function deepMerge<A extends object, B extends object>(base: A, over: B, options?: DeepMergeOptions): A & B {
  if (!isStrictPlainObject(base) || !isStrictPlainObject(over)) throw new TypeError('deepMerge: both arguments must be plain objects');
  return mergeValue(base, over, options?.arrays === 'concat', new Set(), new Set()) as A & B;
}

function mergeValue(a: unknown, b: unknown, concat: boolean, pathA: Set<object>, pathB: Set<object>): unknown {
  if (b === undefined) return cloneTree(a, pathA);
  if (concat && Array.isArray(a) && Array.isArray(b)) return [...(cloneTree(a, pathA) as unknown[]), ...(cloneTree(b, pathB) as unknown[])];
  if (!isStrictPlainObject(a) || !isStrictPlainObject(b)) return cloneTree(b, pathB);
  enter(a, pathA);
  enter(b, pathB);
  try {
    const out: Obj = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (UNSAFE_KEYS.has(k)) continue;
      const inBase = Object.hasOwn(a, k);
      const bv = Object.hasOwn(b, k) ? b[k] : undefined;
      if (!inBase && bv === undefined) continue;
      defineOwn(out, k, mergeValue(inBase ? a[k] : undefined, bv, concat, pathA, pathB));
    }
    return out;
  } finally {
    pathA.delete(a);
    pathB.delete(b);
  }
}

function cloneTree(v: unknown, path: Set<object>): unknown {
  if (!Array.isArray(v) && !isStrictPlainObject(v)) return v;
  enter(v, path);
  try {
    if (Array.isArray(v)) return v.map((x) => cloneTree(x, path));
    const out: Obj = {};
    for (const k of Object.keys(v)) {
      if (!UNSAFE_KEYS.has(k)) defineOwn(out, k, cloneTree(v[k], path));
    }
    return out;
  } finally {
    path.delete(v);
  }
}

function enter(v: object, path: Set<object>): void {
  if (path.has(v)) throw new TypeError('deepMerge: the value holds a cycle');
  path.add(v);
}
