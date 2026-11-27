import _ from 'lodash';

/** The object a lazy-var proxy stands for, so that a walk lists keys without loading a var. */
export type Unwrap = (value: object) => object;

const isRecord = (value: unknown): value is Record<string, unknown> => _.isPlainObject(value);

const rawOf = (value: unknown, unwrap: Unwrap): unknown => (typeof value === 'object' && value !== null ? unwrap(value) : value);

function childOf(node: unknown, segment: string): unknown {
  if (Array.isArray(node)) {
    const items: unknown[] = node;
    return items[Number(segment)];
  }
  return isRecord(node) ? node[segment] : undefined;
}

/**
 * The keys `before` has and `after` lacks, as paths from the two roots, in the order of `before`. Validation removes
 * keys and adds defaults only, so a key missing from `after` is one it dropped. A class instance is a value: not walked.
 */
export function droppedKeys(before: unknown, after: unknown, unwrap: Unwrap, at: readonly string[] = [], seen = new Set<unknown>()): string[][] {
  const b = rawOf(before, unwrap);
  const a = rawOf(after, unwrap);
  // A value may hold itself, and the walk goes below what the schema describes: each object is walked once.
  if (seen.has(b)) return [];
  if (typeof b === 'object' && b !== null) seen.add(b);
  if (Array.isArray(b)) {
    if (!Array.isArray(a)) return [];
    const items: unknown[] = b;
    return items.flatMap((v, i) => droppedKeys(v, childOf(a, String(i)), unwrap, [...at, String(i)], seen));
  }
  if (!isRecord(b) || !isRecord(a)) return [];
  return Object.keys(b).flatMap((k) => (Object.hasOwn(a, k) ? droppedKeys(b[k], a[k], unwrap, [...at, k], seen) : [[...at, k]]));
}

/** The keys of the object at `path` inside `value`; none when there is no object there. */
export function keysAt(value: unknown, path: readonly string[], unwrap: Unwrap): string[] {
  const node = path.reduce<unknown>((n, segment) => rawOf(childOf(n, segment), unwrap), rawOf(value, unwrap));
  return isRecord(node) ? Object.keys(node) : [];
}

function subSchemaOf(node: Record<string, unknown>, segment: string): unknown {
  const properties = node.properties;
  if (isRecord(properties) && Object.hasOwn(properties, segment)) return properties[segment];
  return isRecord(node.items) ? node.items : node.additionalProperties;
}

/** The `properties` names of the sub-schema at instance `path`, reached through `properties`, `items` and `additionalProperties` only. */
export function declaredKeysAt(schema: unknown, path: readonly string[]): string[] {
  const node = path.reduce<unknown>((n, segment) => (isRecord(n) ? subSchemaOf(n, segment) : undefined), schema);
  return isRecord(node) && isRecord(node.properties) ? Object.keys(node.properties) : [];
}

function editDistance(a: string, b: string): number {
  let previous = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/** The candidate nearest to `key`, ignoring case, when at most a third of the key's length of edits away (at least one). */
export function nearestKey(key: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Math.max(1, Math.floor(key.length / 3)) + 1;
  for (const candidate of candidates) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
