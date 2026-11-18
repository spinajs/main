import type { PolicyIR } from '@spinajs/authz-ir';
import type { Permission } from '@spinajs/authz';

import { RewriteAutomaton } from './graph.js';
import { explore, reachersOf } from './monotone.js';
import type { ReachPath } from './monotone.js';
import { bounded } from './smt/solve.js';
import type { BoundedOptions } from './smt/solve.js';
import { confirm, opaqueOf } from './verdict.js';
import type { Verdict } from './verdict.js';
import type { Scenario } from './witness.js';

/** The principal of `scenario` under a ceiling that lists `a` only keeps `a` and loses `b`. @throws WitnessRejected */
async function separatedBy(ir: PolicyIR, scenario: Scenario, a: Permission, b: Permission, found: Pick<Verdict, 'engine' | 'bound'>, path?: ReachPath): Promise<Verdict> {
  const narrowed: Scenario = { ...scenario, principal: { ...scenario.principal, ceiling: { permissions: [a] } } };
  const counterexample = await confirm(ir, narrowed, { [a]: 'allow', [b]: 'not-allow' }, path);
  return { result: 'violated', engine: found.engine, ...(found.bound === undefined ? {} : { bound: found.bound }), counterexample, opaque: opaqueOf(ir) };
}

/**
 * `implies(a, b)` over principals with a ceiling: whoever reaches `a` keeps it under `{ permissions: [a] }` and
 * loses `b`. The witness is an unconditional path to `a`, else a model of the bounded engine; where only
 * conditional paths reach `a` and the bounded engine finds no model, the answer is its `holds` (nothing reaches `a`
 * up to the bound) or `unknown`.
 * Undefined when the unnarrowed verdict stands: no ceiling is compiled, `a` is `b`, or the rewrite automaton has no
 * path to `a`.
 * @throws WitnessRejected when the evaluator disagrees with the analyzer
 */
export async function narrowedImplies(ir: PolicyIR, a: Permission, b: Permission, options: BoundedOptions = {}): Promise<Verdict | undefined> {
  if (!ir.principal.ceiling || a === b) return undefined;
  const automaton = new RewriteAutomaton(ir);
  const start = automaton.start(a);
  if (start === undefined) return undefined;
  const reach = explore(automaton, start);
  const sure = reachersOf(ir, a, reach).find((r) => !r.conditional);
  if (sure !== undefined) return separatedBy(ir, sure.witness, a, b, { engine: 'exact' }, sure.paths[0]);
  if (reach.monotone) return undefined;
  const model = await bounded(ir, { checks: [{ permission: a, allowed: true }] }, options);
  if (model.result !== 'violated' || model.counterexample === undefined) return model;
  return separatedBy(ir, model.counterexample, a, b, model);
}
