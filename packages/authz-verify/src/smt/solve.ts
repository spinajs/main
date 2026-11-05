import type { PolicyIR } from '@spinajs/authz-ir';
import type { Permission } from '@spinajs/authz';

import { outcome } from '../witness.js';
import type { Scenario, WitnessTuple } from '../witness.js';
import { opaqueOf } from '../verdict.js';
import type { Counterexample, Verdict } from '../verdict.js';
import { Encoder, Unsupported, and, not } from './encode.js';
import type { Formula } from './encode.js';
import { universes } from './universe.js';
import type { Universe } from './universe.js';

/** What the bounded engine searches for: data on which each check gets the given answer. */
export interface BoundedQuery {
  readonly checks: ReadonlyArray<{ readonly permission: Permission; readonly allowed: boolean }>;
  /** Tuples the scenario may contain; the others are fixed absent. */
  readonly admit?: (t: WitnessTuple, u: Universe) => boolean;
}

export interface BoundedOptions {
  /** Objects per type (default 3). */
  readonly k?: number;
  /** Models the evaluator may reject before the query answers `unknown` (default 8). */
  readonly attempts?: number;
  /** The solver; default `z3-solver` when installed. */
  readonly solver?: () => Promise<SatSolver | undefined>;
}

/** The part of a SAT solver the bounded engine needs: satisfiable assignments of tuple variables. */
export interface SatSolver {
  /** A model of `formulas` with `defs` as definitions, as the variables that hold, or `undefined` when unsatisfiable. */
  solve(defs: ReadonlyMap<string, Formula>, formulas: readonly Formula[]): Promise<ReadonlySet<string> | undefined>;
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
  const opaque = opaqueOf(ir);
  const solver = await (options.solver ?? loadZ3)();
  if (solver === undefined) return { result: 'unknown', engine: 'bounded', bound: k, opaque, code: 'AZV090', message: 'z3-solver is not installed; non-monotone assertions are not verified' };
  const first = query.checks[0];
  if (first === undefined || !Object.prototype.hasOwnProperty.call(ir.permissions, first.permission)) return { result: 'unknown', engine: 'bounded', bound: k, opaque };
  for (const u of universes(ir, k, ir.permissions[first.permission].type)) {
    let found: Counterexample | 'gave-up' | undefined;
    try {
      found = await search(ir, query, u, solver, options.attempts ?? 8);
    } catch (e) {
      if (e instanceof Unsupported) return { result: 'unknown', engine: 'bounded', bound: k, opaque, message: e.message };
      throw e;
    }
    if (found === 'gave-up') return { result: 'unknown', engine: 'bounded', bound: k, opaque, message: 'the evaluator rejected every model the solver found' };
    if (found !== undefined) return { result: 'violated', engine: 'bounded', bound: k, counterexample: found, opaque };
  }
  return { result: 'holds', engine: 'bounded', bound: k, opaque };
}

async function search(ir: PolicyIR, query: BoundedQuery, u: Universe, solver: SatSolver, attempts: number): Promise<Counterexample | 'gave-up' | undefined> {
  const encoder = new Encoder(ir, u, { maxDepth: 8, ...(query.admit === undefined ? {} : { admit: (t: WitnessTuple) => query.admit!(t, u) }) });
  const goal = and(...query.checks.map((c) => (c.allowed ? encoder.check(c.permission) : not(encoder.check(c.permission)))));
  const formulas: Formula[] = [goal, ...encoder.constraints()];
  for (let i = 0; i < attempts; i++) {
    const model = await solver.solve(encoder.defs, formulas);
    if (model === undefined) return undefined;
    const tuples = [...encoder.tuples.entries()].filter(([name]) => model.has(name));
    const scenario: Scenario = { principal: { type: u.principal.type, id: u.principal.id }, resource: u.resource, tuples: tuples.map(([, t]) => t) };
    const got = await outcome(ir, scenario, query.checks.map((c) => c.permission));
    if (query.checks.every((c) => (got[c.permission] === 'allow') === c.allowed)) return { ...scenario, outcome: got };
    formulas.push(not(and(...[...encoder.tuples.keys()].map((name): Formula => (model.has(name) ? { var: name } : not({ var: name }))))));
  }
  return 'gave-up';
}

