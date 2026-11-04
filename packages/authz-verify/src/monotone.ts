import type { PolicyIR, RelationName, TypeName } from '@spinajs/authz-ir';
import type { Permission } from '@spinajs/authz';

import { ACCEPT, RewriteAutomaton, holderKey } from './graph.js';
import type { Edge, HolderRef } from './graph.js';
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
