import type { PolicyIR, RelationName, TypeName } from '@spinajs/authz-ir';
import type { Permission } from '@spinajs/authz';

import { ACCEPT, RewriteAutomaton, holderKey, letterKey } from './graph.js';
import type { Edge, HolderRef } from './graph.js';
import { confirm, matchesHolder, opaqueOf } from './verdict.js';
import type { Verdict } from './verdict.js';
import { instantiate } from './witness.js';
import type { Scenario } from './witness.js';

export interface ReachPath {
  readonly steps: ReadonlyArray<{ readonly type: TypeName; readonly relation: RelationName; readonly via: 'direct' | 'computed' | 'ttu' }>;
}

export interface Reacher {
  readonly holder: HolderRef;
  /** The shortest path from the resource to the holder, unconditional when one exists. */
  readonly paths: ReachPath[];
  /** Every path to this holder crosses an intersection, exclusion, caveat or priority. */
  readonly conditional: boolean;
  /** The shortest path instantiated as the minimal tuple set that walks it. */
  readonly witness: Scenario;
}

export interface Accepted {
  readonly holder: HolderRef;
  readonly conditional: boolean;
  readonly edges: readonly Edge[];
}

export interface Exploration {
  /** The shortest accepted path per holder and conditionality. */
  readonly accepted: Accepted[];
  /** Names of the `opaque` rewrites reachable from the start. */
  readonly opaque: string[];
  /** No conditional edge and no opaque rewrite is reachable: the exact engine decides this permission. */
  readonly monotone: boolean;
}

interface Node {
  readonly state: string;
  /** The first stored relation the path read, which names its holder. */
  readonly read?: { readonly type: TypeName; readonly relation: RelationName };
  readonly conditional: boolean;
  readonly prev?: Node;
  readonly edge?: Edge;
}

function pathOf(n: Node): Edge[] {
  const out: Edge[] = [];
  for (let at: Node | undefined = n; at?.edge !== undefined; at = at.prev) out.push(at.edge);
  return out.reverse();
}

function follow(n: Node, e: Edge): Node {
  const read = n.read ?? (e.stored ? { type: e.type, relation: e.relation } : undefined);
  return { state: e.to, ...(read === undefined ? {} : { read }), conditional: n.conditional || e.conditional, prev: n, edge: e };
}

const nodeKey = (n: Node): string => `${n.state}|${n.read === undefined ? '' : `${n.read.type}#${n.read.relation}`}|${n.conditional}`;

/**
 * Breadth-first search of the automaton from `start` over (state, holder, conditional) nodes, so every holder gets
 * its shortest path and cycles end. `keep` drops accepted paths whose holder it rejects (`onlyVia`).
 */
export function explore(a: RewriteAutomaton, start: string, keep: (h: HolderRef) => boolean = () => true): Exploration {
  const seen = new Set<string>();
  const accepted = new Map<string, Accepted>();
  const opaque = new Set<string>();
  let monotone = true;
  const queue: Node[] = [{ state: start, conditional: false }];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    for (const o of a.opaqueAt(n.state)) opaque.add(o);
    for (const e of a.edges(n.state)) {
      monotone &&= !e.conditional;
      const next = follow(n, e);
      if (e.to === ACCEPT) {
        const holder = a.holder(next.read!, e.letter?.wildcard === true);
        const key = `${holderKey(holder)}|${next.conditional}`;
        if (keep(holder) && !accepted.has(key)) accepted.set(key, { holder, conditional: next.conditional, edges: pathOf(next) });
      } else if (!seen.has(nodeKey(next))) {
        seen.add(nodeKey(next));
        queue.push(next);
      }
    }
  }
  return { accepted: [...accepted.values()], opaque: [...opaque].sort(), monotone: monotone && opaque.size === 0 };
}

export const toReachPath = (edges: readonly Edge[]): ReachPath => ({ steps: edges.map((e) => ({ type: e.type, relation: e.relation, via: e.via })) });

/** Reachers from an exploration: one per holder, its unconditional path preferred, sorted by holder key. */
export function reachersOf(ir: PolicyIR, permission: Permission, ex: Exploration): Reacher[] {
  const byHolder = new Map<string, Accepted>();
  for (const x of ex.accepted) {
    const key = holderKey(x.holder);
    const had = byHolder.get(key);
    if (had === undefined || (had.conditional && !x.conditional)) byHolder.set(key, x);
  }
  const type = ir.permissions[permission].type;
  return [...byHolder.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, x]) => ({ holder: x.holder, paths: [toReachPath(x.edges)], conditional: x.conditional, witness: instantiate(type, x.edges) }));
}

/**
 * Every holder with a non-empty reach language for `permission` (G7). Exact in the monotone fragment; elsewhere an
 * upper bound, with the holders behind non-monotone parts marked `conditional`.
 */
export function reachers(ir: PolicyIR, permission: Permission): Reacher[] {
  const a = new RewriteAutomaton(ir);
  const start = a.start(permission);
  return start === undefined ? [] : reachersOf(ir, permission, explore(a, start));
}

interface Pair {
  readonly a: string;
  readonly b: ReadonlySet<string>;
  readonly prev?: Pair;
  readonly edge?: Edge;
}

/** States reachable without consuming a tuple (`computed`, `self` tuplesets and `self` relations). */
function closure(m: RewriteAutomaton, states: Iterable<string>): Set<string> {
  const out = new Set(states);
  const queue = [...out];
  for (let i = 0; i < queue.length; i++) {
    for (const e of m.edges(queue[i])) {
      if (e.letter !== undefined || out.has(e.to)) continue;
      out.add(e.to);
      queue.push(e.to);
    }
  }
  return out;
}

function step(m: RewriteAutomaton, states: ReadonlySet<string>, letter: string): Set<string> {
  const next: string[] = [];
  for (const s of states) for (const e of m.edges(s)) if (e.letter !== undefined && letterKey(e.letter) === letter) next.push(e.to);
  return closure(m, next);
}

function edgesOf(p: Pair, last: Edge): Edge[] {
  const out = [last];
  for (let at: Pair | undefined = p; at?.edge !== undefined; at = at.prev) out.push(at.edge);
  return out.reverse();
}

/**
 * The shortest word `a` accepts and `b` does not: breadth-first search of the product of `a` with the lazy subset
 * construction of `b`. `b` undefined is the empty language.
 */
export function difference(m: RewriteAutomaton, a: string, b: string | undefined): Edge[] | undefined {
  const start: Pair = { a, b: b === undefined ? new Set() : closure(m, [b]) };
  const key = (p: { a: string; b: ReadonlySet<string> }): string => `${p.a}|${[...p.b].sort().join(',')}`;
  const seen = new Set([key(start)]);
  const queue: Pair[] = [start];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    for (const e of m.edges(p.a)) {
      const b2 = e.letter === undefined ? p.b : step(m, p.b, letterKey(e.letter));
      if (e.to === ACCEPT) {
        if (!b2.has(ACCEPT)) return edgesOf(p, e);
        continue;
      }
      const next = { a: e.to, b: b2, prev: p, edge: e };
      if (seen.has(key(next))) continue;
      seen.add(key(next));
      queue.push(next);
    }
  }
  return undefined;
}

/**
 * `a` implies `b`: every principal allowed `a` on a resource is allowed `b` on it, for every data set (G7). Exact
 * when both permissions are monotone: the tuple language of `a` is included in that of `b`. A `violated` verdict
 * carries the shortest separating word as its minimal tuple set, confirmed by the reference evaluator.
 * @throws WitnessRejected when the evaluator disagrees with the analyzer
 */
export async function implies(ir: PolicyIR, a: Permission, b: Permission): Promise<Verdict> {
  const m = new RewriteAutomaton(ir);
  const sa = m.start(a);
  if (sa === undefined) return { result: 'holds', engine: 'exact', opaque: opaqueOf(ir) };
  const ex = [explore(m, sa)];
  const sb = m.start(b);
  if (sb !== undefined) ex.push(explore(m, sb));
  const opaque = opaqueOf(ir, ...ex);
  if (ex.some((x) => !x.monotone)) return { result: 'unknown', engine: 'exact', opaque };
  const type = ir.permissions[a].type;
  const sameType = sb !== undefined && ir.permissions[b].type === type;
  const edges = difference(m, sa, sameType ? sb : undefined);
  if (edges === undefined) return { result: 'holds', engine: 'exact', opaque };
  const counterexample = await confirm(ir, instantiate(type, edges), { [a]: 'allow', [b]: 'not-allow' }, toReachPath(edges));
  return { result: 'violated', engine: 'exact', counterexample, opaque };
}

/**
 * Every path to `permission` goes through one of `holders` (`role:<role>@<type>`, `<type>#<relation>`, `public`):
 * the reach language is empty once their paths are removed. Exact on the monotone fragment.
 * @throws WitnessRejected when the evaluator disagrees with the analyzer
 */
export async function onlyVia(ir: PolicyIR, permission: Permission, holders: readonly string[]): Promise<Verdict> {
  const m = new RewriteAutomaton(ir);
  const start = m.start(permission);
  if (start === undefined) return { result: 'holds', engine: 'exact', opaque: opaqueOf(ir) };
  const ex = explore(m, start, (h) => !holders.some((s) => matchesHolder(s, h)));
  const opaque = opaqueOf(ir, ex);
  if (!ex.monotone) return { result: 'unknown', engine: 'exact', opaque };
  const [first] = ex.accepted;
  if (first === undefined) return { result: 'holds', engine: 'exact', opaque };
  const counterexample = await confirm(ir, instantiate(ir.permissions[permission].type, first.edges), { [permission]: 'allow' }, toReachPath(first.edges));
  return { result: 'violated', engine: 'exact', counterexample, opaque };
}
