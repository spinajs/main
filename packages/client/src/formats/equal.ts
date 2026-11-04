/**
 * The deep equality the server decides `const`, `enum`, `uniqueItems` and `uniqueItemProperties` with (`jsonEqual` in
 * `@spinajs/validation` keywords.ts). Unlike Ajv's fast-deep-equal it never calls a method found on the value itself,
 * so `{"valueOf":1}` is compared by its own keys instead of throwing. 0 equals -0, NaN equals NaN, key order is ignored.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a !== a && b !== b;
  return equalAt(a, b, 0);
}

// Recursion is the fast path; past this depth a subtree is compared by the loop in `equalDeep`.
const RECURSION_LIMIT = 1000;
// JSON cannot be cyclic; this ends a cyclic value built in code, which would otherwise loop for ever.
const MAX_DEPTH = 100000;

function equalAt(a: unknown, b: unknown, depth: number): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a !== a && b !== b;
  if (depth >= RECURSION_LIMIT) return equalDeep(a, b);
  const plan = children(a, b);
  if (typeof plan === 'boolean') return plan;
  const x = a as Record<string | number, unknown>;
  const y = b as Record<string | number, unknown>;
  if (typeof plan === 'number') {
    for (let i = plan; i-- !== 0; ) {
      if (!equalAt(x[i], y[i], depth + 1)) return false;
    }
    return true;
  }
  for (let i = plan.length; i-- !== 0; ) {
    if (!equalAt(x[plan[i]], y[plan[i]], depth + 1)) return false;
  }
  return true;
}

function equalDeep(a: object, b: object): boolean {
  const pending: unknown[] = [];
  if (!comparePair(a, b, 0, pending)) return false;
  while (pending.length !== 0) {
    const depth = pending.pop() as number;
    const y = pending.pop();
    const x = pending.pop();
    if (!comparePair(x, y, depth, pending)) return false;
  }
  return true;
}

/** False when the pair differs; otherwise pushes its children, as `[x, y, depth]` triples, onto `pending`. */
function comparePair(a: unknown, b: unknown, depth: number, pending: unknown[]): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a !== a && b !== b;
  if (depth > MAX_DEPTH) throw new RangeError(`jsonEqual: values nested deeper than ${MAX_DEPTH} levels`);
  const plan = children(a, b);
  if (typeof plan === 'boolean') return plan;
  const x = a as Record<string | number, unknown>;
  const y = b as Record<string | number, unknown>;
  if (typeof plan === 'number') {
    for (let i = plan; i-- !== 0; ) pending.push(x[i], y[i], depth + 1);
  } else {
    for (const key of plan) pending.push(x[key], y[key], depth + 1);
  }
  return true;
}

/** The verdict when it is known without looking inside, else the array length or the keys to compare. */
function children(a: object, b: object): boolean | number | string[] {
  const proto = Object.getPrototypeOf(a) as object | null;
  if (proto !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length ? a.length : false;
  if (proto !== null && proto !== Object.prototype) {
    const byPrototype = prototypeEqual(proto, a, b);
    if (byPrototype !== undefined) return byPrototype;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (let i = keys.length; i-- !== 0; ) {
    if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
  }
  return keys;
}

// Undefined when the prototype has no comparison of its own and the values are compared by their keys.
function prototypeEqual(proto: object, a: object, b: object): boolean | undefined {
  if (a instanceof RegExp) return a.source === (b as RegExp).source && a.flags === (b as RegExp).flags;
  const { valueOf, toString } = proto as { valueOf?: unknown; toString?: unknown };
  if (typeof valueOf === 'function' && valueOf !== Object.prototype.valueOf) return valueOf.call(a) === valueOf.call(b);
  if (typeof toString === 'function' && toString !== Object.prototype.toString) return toString.call(a) === toString.call(b);
  return undefined;
}
