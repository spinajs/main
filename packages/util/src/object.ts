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
 * @returns `v`
 */
export function deepFreeze<T>(v: T): Readonly<T> {
  freezeAll(v, new WeakSet());
  return v;
}

function freezeAll(v: unknown, seen: WeakSet<object>): void {
  if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v) || seen.has(v)) return;
  seen.add(v);
  Object.freeze(v);
  for (const x of Object.values(v)) freezeAll(x, seen);
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
