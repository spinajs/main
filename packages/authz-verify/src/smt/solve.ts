import type { OpaqueRef, PolicyIR } from '@spinajs/authz-ir';
import type { Permission } from '@spinajs/authz';

import { outcome } from '../witness.js';
import type { Scenario, WitnessTuple } from '../witness.js';
import { opaqueOf } from '../verdict.js';
import type { Counterexample, Verdict } from '../verdict.js';
import { Encoder } from './encode.js';
import { Unsupported, and, not } from './formula.js';
import type { Formula } from './formula.js';
import { minimize } from './minimize.js';
import { universes } from './universe.js';
import type { Universe } from './universe.js';

/** What the bounded engine searches for: data on which each check gets the given answer. */
export interface BoundedQuery {
  readonly checks: ReadonlyArray<{ readonly permission: Permission; readonly allowed: boolean }>;
  /** Tuples the scenario may contain; the others are fixed absent. */
  readonly admit?: (t: WitnessTuple, u: Universe) => boolean;
  /** Further constraints over the encoding, built once the checks are encoded (`isolated`). */
  readonly extra?: (e: Encoder, u: Universe) => Formula[];
}

export interface BoundedOptions {
  /** Objects per type (default 3). */
  readonly k?: number;
  /** Models the evaluator may reject before the query answers `unknown` (default 8). */
  readonly attempts?: number;
  /** The solver; default `z3-solver` when installed. */
  readonly solver?: () => Promise<SatSolver | undefined>;
}

/** A satisfying assignment: the boolean variables that hold and the value of every numeric variable. */
export interface SatModel {
  readonly holds: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, number>;
}

/** The part of an SMT solver the bounded engine needs. */
export interface SatSolver {
  /** A model of `formulas` with `defs` as definitions, or `undefined` when unsatisfiable. */
  solve(defs: ReadonlyMap<string, Formula>, formulas: readonly Formula[]): Promise<SatModel | undefined>;
}

/** The `z3-solver` adapter, when the optional peer is installed (G8). Loaded only here, never by runtime code. */
async function loadZ3(): Promise<SatSolver | undefined> {
  const { z3Solver } = await import('./z3.js');
  return z3Solver();
}

/** Stops the solver's worker threads after the last bounded query, so the process can exit. */
export async function releaseSolver(): Promise<void> {
  const { releaseZ3 } = await import('./z3.js');
  await releaseZ3();
}

/**
 * Searches every universe of `k` objects per type for a scenario that answers the query, re-running each model
 * through the reference evaluator before calling it a counterexample (G7). No model means `holds` up to `k`.
 */
export async function bounded(ir: PolicyIR, query: BoundedQuery, options: BoundedOptions = {}): Promise<Verdict> {
  const k = options.k ?? 3;
  const solver = await (options.solver ?? loadZ3)();
  if (solver === undefined) return { result: 'unknown', engine: 'bounded', bound: k, opaque: opaqueOf(ir), code: 'AZV090', message: 'z3-solver is not installed; non-monotone assertions are not verified' };
  const first = query.checks[0];
  if (first === undefined || !Object.prototype.hasOwnProperty.call(ir.permissions, first.permission)) return { result: 'unknown', engine: 'bounded', bound: k, opaque: opaqueOf(ir) };
  let opaque = opaqueOf(ir);
  for (const u of universes(ir, k, ir.permissions[first.permission].type)) {
    let found: Found;
    try {
      found = await search(ir, query, u, solver, options.attempts ?? 8);
    } catch (e) {
      if (e instanceof Unsupported) return { result: 'unknown', engine: 'bounded', bound: k, opaque, message: e.message };
      throw e;
    }
    opaque = [...opaque, ...found.opaque.filter((o) => !opaque.some((x) => x.kind === o.kind && x.name === o.name))];
    if (found.result === 'gave-up') return { result: 'unknown', engine: 'bounded', bound: k, opaque, message: 'the reference evaluator rejected a model, so the search is not complete' };
    if (found.result !== undefined) return { result: 'violated', engine: 'bounded', bound: k, counterexample: found.result, opaque };
  }
  return { result: 'holds', engine: 'bounded', bound: k, opaque };
}

interface Found {
  readonly result: Counterexample | 'gave-up' | undefined;
  readonly opaque: OpaqueRef[];
}

/**
 * One universe. A model the evaluator rejects is blocked by its tuples, which may also block a context that would
 * have worked, so once a model was rejected an unsatisfiable answer no longer proves anything.
 */
async function search(ir: PolicyIR, query: BoundedQuery, u: Universe, solver: SatSolver, attempts: number): Promise<Found> {
  const encoder = new Encoder(ir, u, { maxDepth: 8, ...(query.admit === undefined ? {} : { admit: (t: WitnessTuple) => query.admit!(t, u) }) });
  const goal = and(...query.checks.map((c) => (c.allowed ? encoder.check(c.permission) : not(encoder.check(c.permission)))));
  const extra = query.extra?.(encoder, u) ?? [];
  const formulas: Formula[] = [goal, ...extra, ...encoder.constraints()];
  const expected = Object.fromEntries(query.checks.map((c) => [c.permission, c.allowed]));
  const opaque = encoder.caveats.opaque;
  for (let i = 0; i < attempts; i++) {
    const model = await solver.solve(encoder.defs, formulas);
    if (model === undefined) return { result: i === 0 ? undefined : 'gave-up', opaque };
    const tuples = [...encoder.tuples.entries()].filter(([name]) => model.holds.has(name));
    const scenario: Scenario = { principal: { type: u.principal.type, id: u.principal.id }, resource: u.resource, tuples: tuples.map(([, t]) => t), ...(encoder.caveats.params.size === 0 ? {} : { context: encoder.caveats.context(model) }) };
    const got = await outcome(ir, scenario, Object.keys(expected));
    if (Object.entries(expected).every(([p, allowed]) => (got[p] === 'allow') === allowed)) {
      return { result: { ...(await minimize(ir, scenario, got)), outcome: got }, opaque };
    }
    formulas.push(not(and(...[...encoder.tuples.keys()].map((name): Formula => (model.holds.has(name) ? { var: name } : not({ var: name }))))));
  }
  return { result: 'gave-up', opaque };
}
