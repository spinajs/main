import _ from 'lodash';

export const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

type Override = [at: string[], value: unknown];

const startsWith = (path: readonly string[], prefix: readonly string[]): boolean => prefix.length <= path.length && _.isEqual(path.slice(0, prefix.length), prefix);

// The most specific override at or above `segments`, and the overrides below it relative to `segments`.
function partition(segments: readonly string[], values: ReadonlyMap<string, unknown>): { above: Override | undefined; below: Override[] } {
  let above: Override | undefined;
  const below: Override[] = [];
  for (const [path, value] of values) {
    const at = path.split('.');
    if (startsWith(segments, at)) {
      if (above === undefined || at.length > above[0].length) above = [at, value];
    } else if (startsWith(at, segments) && !at.some((s) => UNSAFE_PATH_SEGMENTS.has(s))) {
      below.push([at.slice(segments.length), value]);
    }
  }
  return { above, below };
}

function layOver(base: unknown, below: Override[], copy: (node: unknown) => object): object {
  const root = copy(base);
  const fresh = new Set<object>([root]);
  for (const [at, value] of below.sort((a, b) => a[0].length - b[0].length)) {
    let node = root;
    for (const key of at.slice(0, -1)) {
      const existing: unknown = Reflect.get(node, key);
      if (typeof existing === 'object' && existing !== null && fresh.has(existing)) {
        node = existing;
        continue;
      }
      const child = copy(existing);
      fresh.add(child);
      Reflect.set(node, key, child);
      node = child;
    }
    // Not _.set: it reads the old value first, which would resolve the lazy var being replaced.
    Reflect.set(node, at[at.length - 1], value);
  }
  return root;
}

/**
 * What a read of `segments` answers once the overlay `values` (by dotted path) lie over the merged `config`: the value of
 * the most specific overridden path at or above `segments`, with every override below `segments` laid in. Only the
 * objects on the way to such an override are copied, by `copy`; everything else is the merged tree's own value. Of two
 * nested overrides the more specific wins. Undefined when no override touches `segments`.
 */
export function overlaidValue(config: object, segments: readonly string[], values: ReadonlyMap<string, unknown>, copy: (node: unknown) => object): { value: unknown } | undefined {
  const { above, below } = partition(segments, values);
  if (above === undefined && below.length === 0) return undefined;
  const base: unknown = above === undefined ? _.get(config, [...segments]) : segments.length === above[0].length ? above[1] : _.get(above[1], segments.slice(above[0].length));
  return { value: below.length === 0 ? base : layOver(base, below, copy) };
}
