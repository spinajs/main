export type Plain = Record<string, unknown>;

export const isPlain = (v: unknown): v is Plain => v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));

export const keyPath = (parent: string, key: string): string => (/^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`);

/** The first path below `value` (as `root` + sub-path) that a config file cannot spell as a literal: a function, a class instance, a symbol, NaN. */
export function firstNonData(value: unknown, root: string): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : root;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const bad = firstNonData(value[i], `${root}[${i}]`);
      if (bad !== undefined) return bad;
    }
    return undefined;
  }
  if (isPlain(value)) {
    for (const [k, v] of Object.entries(value)) {
      const bad = firstNonData(v, keyPath(root, k));
      if (bad !== undefined) return bad;
    }
    return undefined;
  }
  return root;
}

export function getPath(root: unknown, path: readonly string[]): unknown {
  let at = root;
  for (const k of path) {
    if (!isPlain(at)) return undefined;
    at = at[k];
  }
  return at;
}

export function setPath(root: Plain, path: readonly string[], value: unknown): void {
  let at = root;
  for (const k of path.slice(0, -1)) {
    if (!isPlain(at[k])) at[k] = {};
    at = at[k] as Plain;
  }
  at[path[path.length - 1]] = value;
}

/** Plain data copy; callers have checked it with `firstNonData`. */
export function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copy) as T;
  if (isPlain(value)) return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, copy(v)])) as T;
  return value;
}

export const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
