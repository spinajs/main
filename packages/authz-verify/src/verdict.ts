import type { OpaqueRef, PolicyIR, Truth } from '@spinajs/authz-ir';
import type { Permission } from '@spinajs/authz';

import { holderKey } from './graph.js';
import type { HolderRef } from './graph.js';
import type { Exploration, ReachPath } from './monotone.js';
import { WitnessRejected, outcome } from './witness.js';
import type { Scenario } from './witness.js';

/** A scenario that breaks an assertion, with what the reference evaluator answered on it. */
export interface Counterexample extends Scenario {
  readonly path?: ReachPath;
  readonly outcome: Record<Permission, Truth>;
}

/**
 * `exact`: decided on the monotone fragment for every data set. `bounded`: no counterexample over `bound` objects
 * per type. `unknown` carries the engine that gave up, so the other one can take over.
 */
export interface Verdict {
  readonly result: 'holds' | 'violated' | 'unknown';
  readonly engine: 'exact' | 'bounded';
  readonly bound?: number;
  readonly counterexample?: Counterexample;
  /** Parts the analysis cannot see: `ir.opaque` plus the opaque rewrites the permissions reach. */
  readonly opaque: OpaqueRef[];
  /** `AZV090` when the bounded engine had no solver. */
  readonly code?: 'AZV090';
  /** Why an `unknown` verdict was not decided. */
  readonly message?: string;
}

export function opaqueOf(ir: PolicyIR, ...explorations: Exploration[]): OpaqueRef[] {
  const names = [...new Set(explorations.flatMap((x) => x.opaque))].sort();
  return [...ir.opaque, ...names.map((name): OpaqueRef => ({ kind: 'rewrite', name }))];
}

/** Re-runs a witness through the reference evaluator (G7); a disagreement is an analyzer bug. */
export async function confirm(ir: PolicyIR, scenario: Scenario, expected: Record<Permission, 'allow' | 'not-allow'>, path?: ReachPath): Promise<Counterexample> {
  const got = await outcome(ir, scenario, Object.keys(expected));
  for (const [permission, want] of Object.entries(expected)) {
    if ((got[permission] === 'allow') !== (want === 'allow')) throw new WitnessRejected(`the evaluator answers ${got[permission]} for ${permission} on the witness, expected ${want}`);
  }
  return { ...scenario, ...(path === undefined ? {} : { path }), outcome: got };
}

/** `holderKey(h)`, `type#relation` of any non-public holder, `role:<name>` on any type, or `public`. */
export function matchesHolder(selector: string, h: HolderRef): boolean {
  if (selector === holderKey(h)) return true;
  if (h.kind === 'public') return selector === 'public';
  return selector === `${h.type}#${h.relation}` || (h.kind === 'role' && selector === `role:${h.role!}`);
}
