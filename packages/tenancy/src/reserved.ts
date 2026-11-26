export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** The first own key of `value`, at any depth, that names a prototype member; undefined when it holds none. */
export function reservedKeyIn(value: unknown, seen = new Set<object>()): string | undefined {
  if (value === null || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const found = RESERVED_SEGMENTS.has(key) ? key : reservedKeyIn(child, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}
