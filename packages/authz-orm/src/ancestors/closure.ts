import { AuthzConfigError, resourceKey } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';

export interface Link {
  readonly type: string;
  readonly id: string;
  readonly depth: number;
}

const byDepthThenKey = (a: Link, b: Link): number => a.depth - b.depth || (resourceKey(a) < resourceKey(b) ? -1 : resourceKey(a) > resourceKey(b) ? 1 : 0);

/**
 * The proper ancestors of every node: per direct parent p, p at depth 1 and p's ancestors one deeper,
 * the smallest depth winning where chains meet. A parent in `nodes` is computed first (memoised DFS);
 * any other parent's ancestors come from `outside` (the table). Parents in `gone` count as absent.
 */
export function closeOver(nodes: readonly ResourceRef[], parents: ReadonlyMap<string, readonly ResourceRef[]>, outside: ReadonlyMap<string, readonly Link[]>, gone: ReadonlySet<string> = new Set()): Map<string, Link[]> {
  const inNodes = new Set(nodes.map((n) => resourceKey(n)));
  const done = new Map<string, Link[]>();
  const active = new Set<string>();

  const linksOf = (key: string): Link[] => {
    const hit = done.get(key);
    if (hit) return hit;
    if (active.has(key)) throw new AuthzConfigError(`authz-orm: the @Parent links form a cycle through ${key}`);
    active.add(key);
    const best = new Map<string, Link>();
    const add = (l: Link): void => {
      const k = resourceKey(l);
      const prev = best.get(k);
      if (prev === undefined || l.depth < prev.depth) best.set(k, Object.freeze({ type: l.type, id: l.id, depth: l.depth }));
    };
    for (const p of parents.get(key) ?? []) {
      const pk = resourceKey(p);
      if (gone.has(pk)) continue;
      add({ type: p.type, id: String(p.id), depth: 1 });
      const above = inNodes.has(pk) ? linksOf(pk) : outside.get(pk) ?? [];
      for (const a of above) if (!gone.has(resourceKey(a))) add({ type: a.type, id: a.id, depth: a.depth + 1 });
    }
    if (best.has(key)) throw new AuthzConfigError(`authz-orm: the @Parent links form a cycle through ${key}`);
    active.delete(key);
    const out = [...best.values()].sort(byDepthThenKey);
    done.set(key, out);
    return out;
  };

  for (const k of inNodes) linksOf(k);
  return done;
}
