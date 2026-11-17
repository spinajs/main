import { AuthzConfigError } from '@spinajs/authz';
import type { ReplayRead } from '@spinajs/authz';

import { stableStringify } from '../canonical.js';
import { parseSubjectTypeRef } from '../ir.js';
import type { PolicyIR, RelationName, Rewrite, TypeDef, TypeName } from '../ir.js';
import type { StoredPolicySplicer } from './contributor.js';
import { coverageGap, stateAt } from './history.js';
import type { KeyState } from './history.js';
import type { ReplayHistory } from './history-scan.js';

type Items = ReadonlyArray<{ key: string; state: KeyState }>;

/**
 * The config IR with every `stored:<model>:<store>` placeholder a splicer locates replaced by the stored items live at
 * `at` (section 3.4). Item keys are changelog keys of the splicer's kind. A placeholder whose kind is not covered at
 * `at` stays opaque: an empty store there proves nothing. With `from`, only the permissions a check of it can reach are
 * spliced, so stores the decision never reads cost no history and name no gaps.
 */
export async function spliceStoredPolicy(ir: PolicyIR, at: Date, splicers: readonly StoredPolicySplicer[], history: ReplayHistory, from?: { type: TypeName; relation: RelationName }): Promise<{ ir: PolicyIR; reads: ReplayRead[] }> {
  const reads: ReplayRead[] = [];
  if (splicers.length === 0) return { ir, reads };
  const out = structuredClone(ir);
  const stores = new Map<string, Promise<Items | string>>();
  const placeholder = async (name: string, type: TypeName, relation: RelationName): Promise<Rewrite | undefined> => {
    const located = splicers.flatMap((s) => {
      const place = s.locate(name, type, relation, out);
      return place === undefined ? [] : [{ s, place }];
    });
    if (located.length > 1) throw new AuthzConfigError(`replay: ${located.length} stored-policy splicers locate ${name} at ${type}#${relation}`);
    if (located.length === 0) return undefined;
    const { s, place } = located[0];
    const slot = `${splicers.indexOf(s)}\u0000${place.store}`;
    if (!stores.has(slot)) stores.set(slot, itemsAt(s, place.store, at, history, reads));
    const items = await stores.get(slot)!;
    if (typeof items === 'string') return undefined;
    const spliced = s.splice(place, items, out);
    merge(out, spliced.caveats ?? {}, spliced.opaque ?? []);
    return spliced.term;
  };
  // In sequence: the history's reads of one store must not interleave with another's.
  const reached = from === undefined ? undefined : reachable(out, from.type, from.relation);
  const types: Array<[TypeName, TypeDef]> = [];
  for (const [type, def] of Object.entries(out.types)) {
    const permissions: Array<[RelationName, Rewrite]> = [];
    for (const [relation, r] of Object.entries(def.permissions)) permissions.push([relation, reached?.has(`${type}#${relation}`) === false ? r : await rewrite(r, (n) => placeholder(n, type, relation))]);
    types.push([type, { ...def, permissions: Object.fromEntries(permissions) }]);
  }
  return { ir: { ...out, types: Object.fromEntries(types) }, reads };
}

/** `type#name` of every relation and permission a check of `type#relation` can hop to, by the hops the walker makes. */
function reachable(ir: PolicyIR, type: TypeName, relation: RelationName): Set<string> {
  const seen = new Set<string>();
  const typeOf = (t: TypeName): TypeDef | undefined => Object.entries(ir.types).find(([n]) => n === t)?.[1];
  const subjectSets = (t: TypeName, r: RelationName): Array<[TypeName, RelationName]> => {
    const def = Object.entries(typeOf(t)?.relations ?? {}).find(([n]) => n === r)?.[1];
    return (def?.allowed ?? []).flatMap((a) => {
      const p = parseSubjectTypeRef(a);
      return p.relation === undefined ? [] : [[p.type, p.relation]];
    });
  };
  const walk = (t: TypeName, r: Rewrite): void => {
    if ('computed' in r) visit(t, r.computed);
    else if ('tupleToUserset' in r) {
      const via = Object.entries(typeOf(t)?.relations ?? {}).find(([n]) => n === r.tupleToUserset.tupleset)?.[1];
      for (const a of via?.allowed ?? []) visit(parseSubjectTypeRef(a).type, r.tupleToUserset.computed);
    } else if ('union' in r) r.union.forEach((x) => walk(t, x));
    else if ('intersection' in r) r.intersection.forEach((x) => walk(t, x));
    else if ('exclusion' in r) [r.exclusion.base, r.exclusion.subtract].forEach((x) => walk(t, x));
    else if ('caveat' in r) walk(t, r.of);
    else if ('priority' in r) r.priority.forEach((p) => walk(t, p.when));
  };
  const visit = (t: TypeName, name: RelationName): void => {
    if (seen.has(`${t}#${name}`)) return;
    seen.add(`${t}#${name}`);
    for (const [st, sr] of subjectSets(t, name)) visit(st, sr);
    const permission = Object.entries(typeOf(t)?.permissions ?? {}).find(([n]) => n === name)?.[1];
    if (permission !== undefined) walk(t, permission);
  };
  visit(type, relation);
  return seen;
}

async function rewrite(r: Rewrite, replace: (name: string) => Promise<Rewrite | undefined>): Promise<Rewrite> {
  const each = async (rs: readonly Rewrite[]): Promise<Rewrite[]> => {
    const done: Rewrite[] = [];
    for (const x of rs) done.push(await rewrite(x, replace));
    return done;
  };
  if ('opaque' in r) return (await replace(r.opaque)) ?? r;
  if ('union' in r) return { union: await each(r.union) };
  if ('intersection' in r) return { intersection: await each(r.intersection) };
  if ('exclusion' in r) return { exclusion: { base: await rewrite(r.exclusion.base, replace), subtract: await rewrite(r.exclusion.subtract, replace) } };
  if ('caveat' in r) return { caveat: r.caveat, of: await rewrite(r.of, replace) };
  if ('priority' in r) {
    const priority: Array<{ when: Rewrite; then: 'permit' | 'deny' }> = [];
    for (const p of r.priority) priority.push({ when: await rewrite(p.when, replace), then: p.then });
    return { priority };
  }
  return r;
}

function merge(ir: PolicyIR, caveats: PolicyIR['caveats'], opaque: PolicyIR['opaque']): void {
  for (const [name, def] of Object.entries(caveats)) {
    const had = Object.entries(ir.caveats).find(([n]) => n === name)?.[1];
    if (had !== undefined && stableStringify(had) !== stableStringify(def)) throw new AuthzConfigError(`replay: a spliced caveat ${name} differs from the one the IR holds`);
    Object.defineProperty(ir.caveats, name, { value: def, enumerable: true, writable: true, configurable: true });
  }
  for (const o of opaque) if (!ir.opaque.some((x) => stableStringify(x) === stableStringify(o))) ir.opaque.push(o);
}

/** The store's items at `at`, in the read order of section 3.2; the coverage gap as a string when the kind is not covered. */
async function itemsAt(s: StoredPolicySplicer, store: string, at: Date, history: ReplayHistory, reads: ReplayRead[]): Promise<Items | string> {
  const current = await s.current(store);
  await history.catchUp();
  const changed: string[] = [];
  let anonymous: number | undefined;
  for (const c of history.changesOf(s.kind)) {
    const e = s.edge(c);
    if (e === undefined) anonymous ??= c.seq;
    else if (e.store === store) changed.push(e.key);
  }
  const keys = [...new Set([...current.map((i) => i.key), ...changed])];
  const heads = await history.headOf(s.kind, keys);
  const befores = await history.beforeOf(s.kind, keys);
  const since = await history.since(s.kind);
  // An item of this store may be the one that change touched: without it the set would be silently shorter.
  const uncovered = anonymous === undefined ? coverageGap(at, s.kind, since, history.window) : `${s.kind} change seq ${anonymous} names no store`;
  if (uncovered !== undefined) {
    reads.push({ kind: s.kind, key: `${s.kind}:${store}`, origin: 'gap', reason: uncovered });
    return uncovered;
  }
  const images = new Map(current.map((i) => [i.key, i.image]));
  return keys.map((key) => {
    const after = history.afterFor(s.kind, key);
    const before = befores.get(key);
    const head = heads.get(key);
    const moved = head !== undefined && head.seq > Math.max(after.at(-1)?.seq ?? -Infinity, before?.seq ?? -Infinity);
    const state: KeyState = moved ? { known: false, reason: `${s.kind} ${key} changed during the replay` } : stateAt(at, { kind: s.kind, current: images.get(key), after, before, since, window: history.window, precisionMs: history.precisionMs });
    reads.push(state.known ? { kind: s.kind, key, origin: state.origin, ...(state.seq === undefined ? {} : { seq: state.seq }) } : { kind: s.kind, key, origin: 'gap', reason: state.reason });
    return { key, state };
  });
}
