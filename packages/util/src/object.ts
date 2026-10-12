/**
 * Type guard for non-null objects that are not arrays. Class instances match too.
 *
 * @param v - value to test
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Freezes `v` and everything reachable through its own enumerable properties, in place.
 *
 * @param v - value to freeze
 * @returns `v`
 */
export function deepFreeze<T>(v: T): Readonly<T> {
  if (v === null || typeof v !== 'object' || Object.isFrozen(v)) return v;
  Object.freeze(v);
  for (const x of Object.values(v)) deepFreeze(x);
  return v;
}

/**
 * Deep clone of `v` that is frozen. `Date`s are cloned too, as a frozen `Date` can still be changed with `setTime`.
 *
 * @param v - value to copy
 * @param maxDepth - values nested deeper than this become `undefined`
 */
export function frozenCopy<T>(v: T, maxDepth = 16): Readonly<T> {
  return copyFrozen(v, maxDepth, 0) as Readonly<T>;
}

function copyFrozen(v: unknown, maxDepth: number, depth: number): unknown {
  if (depth > maxDepth) return undefined;
  if (v instanceof Date) return Object.freeze(new Date(v.getTime()));
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return Object.freeze(v.map((x) => copyFrozen(x, maxDepth, depth + 1)));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = copyFrozen(x, maxDepth, depth + 1);
  return Object.freeze(out);
}
