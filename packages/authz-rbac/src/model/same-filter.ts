import type { ResourceFilter } from '@spinajs/authz';

/** Nodes and values one comparison may visit; past it the filters count as different. */
const MAX_VISITS = 10_000;
const MAX_DEPTH = 64;

/**
 * Whether two filters are the same tree (RFC C3-1), so they select the same rows. Strict, and never
 * true for filters that may differ: operands compare in order; values (and `native:*` args) compare
 * as primitives by `Object.is`, Dates by time, and arrays and plain objects by their own enumerable
 * data properties, with equal key sets (`{ x: undefined }` is not `{}`). Anything else (Map, Set,
 * functions, class instances, symbol keys, accessors, holes) is the same only as the same reference.
 * Over the work budget, or on a throw, it answers false.
 */
export function sameFilter(a: ResourceFilter, b: ResourceFilter): boolean {
  try {
    return same(a, b, { visits: MAX_VISITS }, 0);
  } catch {
    return false;
  }
}

function same(x: unknown, y: unknown, budget: { visits: number }, depth: number): boolean {
  if (Object.is(x, y)) return true;
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
  if (--budget.visits < 0 || depth > MAX_DEPTH) return false;
  const proto = Object.getPrototypeOf(x);
  if (proto !== Object.getPrototypeOf(y)) return false;
  if (proto === Date.prototype) return Reflect.ownKeys(x).length === 0 && Reflect.ownKeys(y).length === 0 && Object.is((x as Date).getTime(), (y as Date).getTime());
  if (proto !== Object.prototype && proto !== null && !(proto === Array.prototype && Array.isArray(x) && Array.isArray(y))) return false;
  const xs = dataProperties(x);
  const ys = dataProperties(y);
  if (!xs || !ys || xs.size !== ys.size) return false;
  for (const [key, value] of xs) {
    if (!ys.has(key) || !same(value, ys.get(key), budget, depth + 1)) return false;
  }
  return true;
}

// Values are read once from the descriptors, so a getter or proxy cannot answer differently later in the walk.
function dataProperties(o: object): Map<string, unknown> | undefined {
  const out = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(o)) {
    if (typeof key !== 'string') return undefined;
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (!d || !('value' in d)) return undefined;
    if (!d.enumerable) {
      if (key === 'length' && Array.isArray(o)) continue;
      return undefined;
    }
    out.set(key, d.value);
  }
  if (Array.isArray(o) && out.size !== o.length) return undefined;
  return out;
}
