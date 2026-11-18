const pointer = (key: string | number): string => (typeof key === 'number' ? String(key) : key.replace(/~/g, '~0').replace(/\//g, '~1'));

const walkable = (value: unknown): value is object => {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
};

// About as many containers as a 5 MB body of nested arrays holds ( `[]` is two bytes ).
const CYCLE_GUARD_AFTER = 3_000_000;

/** At most this many non-finite numbers are reported; `findNonFinite` looks for one more, to tell there are others. */
export const NON_FINITE_REPORT_LIMIT = 100;

/**
 * A reported path holds at most this many segments and characters, so its cost and size do not grow with the depth
 * or a key of the data. A longer one keeps its leading segments, which name the field, and ends with `/…`.
 */
const MAX_PATH_SEGMENTS = 64;
const MAX_PATH_LENGTH = 1024;
const ELIDED = '/…';

/**
 * The JSON pointers of the non-finite numbers in validated data. JSON carries one only through coercion or a literal
 * such as `1e400`, and a subschema that may fail ( `if`, an `anyOf` / `oneOf` branch, `not` ) coerces in place before
 * it fails, where no `type` rule sees the result. `data` itself is walked whatever its class ( a `@Schema` DTO ); below
 * it plain objects and arrays, as JSON builds them. A loop, not recursion, so no depth overflows it. With `all`, up
 * to {@link NON_FINITE_REPORT_LIMIT} + 1 paths, in breadth-first order; else the first.
 *
 * @internal
 */
export function findNonFinite(data: unknown, all: boolean): string[] {
  if (typeof data === 'number') return Number.isFinite(data) ? [] : [''];
  if (!data || typeof data !== 'object') return [];
  const limit = all ? NON_FINITE_REPORT_LIMIT + 1 : 1;

  // A breadth-first queue that keeps each container's parent and key, not its path: a string per value made a deeply
  // nested body cost seconds. The path is joined only for a hit.
  const values: object[] = [data];
  const parents: number[] = [-1];
  const keys: (string | number)[] = [''];
  // The depth of each container, and its ancestor at depth MAX_PATH_SEGMENTS ( itself when shallower ): a capped path
  // is built from there, never from the whole chain.
  const depths: number[] = [0];
  const anchors: number[] = [0];
  const hits: [number, string | number][] = [];
  // Only a cycle walked before the guard below starts revisits a holder of a hit: report each holder and key once.
  const reported = new Map<object, Set<string | number>>();
  // JSON input is a tree: no cycle, no shared value, so it never needs the guard. Only data built in code can be
  // cyclic, and it pays by queueing up to this many containers first; a WeakSet over millions of containers cost
  // several times the walk itself.
  let seen: WeakSet<object> | undefined;

  const visit = (index: number, key: string | number, child: unknown) => {
    if (typeof child === 'number') {
      if (!Number.isFinite(child)) report(index, key);
      return;
    }
    if (!walkable(child)) return;
    if (seen === undefined && values.length > CYCLE_GUARD_AFTER) seen = new WeakSet<object>();
    if (seen !== undefined) {
      if (seen.has(child)) return;
      seen.add(child);
    }
    values.push(child);
    parents.push(index);
    keys.push(key);
    const depth = depths[index] + 1;
    depths.push(depth);
    anchors.push(depth <= MAX_PATH_SEGMENTS ? values.length - 1 : anchors[index]);
  };
  const report = (index: number, key: string | number) => {
    const holder = values[index];
    const holderKeys = reported.get(holder) ?? new Set<string | number>();
    reported.set(holder, holderKeys);
    if (holderKeys.has(key)) return;
    holderKeys.add(key);
    hits.push([index, key]);
  };

  for (let next = 0; next < values.length && hits.length < limit; next++) {
    const value = values[next];
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length && hits.length < limit; i++) visit(next, i, value[i]);
    } else {
      for (const key of Object.keys(value)) {
        if (hits.length >= limit) break;
        visit(next, key, (value as Record<string, unknown>)[key]);
      }
    }
  }

  return hits.map(([index, key]) => {
    const whole = depths[index] < MAX_PATH_SEGMENTS;
    const chain: (string | number)[] = whole ? [key] : [];
    for (let i = whole ? index : anchors[index]; i > 0; i = parents[i]) chain.push(keys[i]);
    return joinPath(chain.reverse(), !whole);
  });
}

// At most MAX_PATH_LENGTH characters. The segment that would pass it is cut to fit, so the path still names the
// field; it is sliced before escaping, so a huge key costs no more than the limit.
function joinPath(segments: (string | number)[], elided: boolean): string {
  let path = '';
  for (const segment of segments) {
    const raw = typeof segment === 'number' ? String(segment) : segment.slice(0, MAX_PATH_LENGTH);
    const part = `/${pointer(raw)}`;
    if (path.length + part.length > MAX_PATH_LENGTH) return `${path}/${escapedPrefix(raw, MAX_PATH_LENGTH - path.length - 1 - ELIDED.length)}${ELIDED}`;
    path += part;
  }
  return elided ? path + ELIDED : path;
}

// The escaped start of `raw` that fits `budget` characters, never ending inside a `~0` / `~1` escape.
function escapedPrefix(raw: string, budget: number): string {
  let escaped = '';
  for (const char of raw) {
    const next = char === '~' ? '~0' : char === '/' ? '~1' : char;
    if (escaped.length + next.length > budget) break;
    escaped += next;
  }
  return escaped;
}
