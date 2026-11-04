import { Unsupported } from './encode.js';
import type { Formula } from './encode.js';
import type { SatSolver } from './solve.js';

import type { Bool, Context } from 'z3-solver';

type Z3Module = typeof import('z3-solver');
type Z3Api = Awaited<ReturnType<Z3Module['init']>>;
type Z3Context = Context<'main'>;
type BoolExpr = Bool<'main'>;

interface Loaded {
  readonly z3: Z3Module;
  readonly api: Z3Api;
  readonly ctx: Z3Context;
}

let loading: Promise<Loaded | undefined> | undefined;

const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException | undefined)?.code === 'ERR_MODULE_NOT_FOUND';

async function load(): Promise<Loaded | undefined> {
  let z3: Z3Module;
  try {
    z3 = await import('z3-solver');
  } catch (e) {
    if (missing(e)) return undefined;
    throw e;
  }
  const api = await z3.init();
  return { z3, api, ctx: api.Context('main') };
}

function translate(ctx: Z3Context, f: Formula, vars: Map<string, BoolExpr>): BoolExpr {
  if (typeof f === 'boolean') return ctx.Bool.val(f);
  if ('var' in f) {
    let v = vars.get(f.var);
    if (v === undefined) {
      v = ctx.Bool.const(f.var);
      vars.set(f.var, v);
    }
    return v;
  }
  if ('not' in f) return ctx.Not(translate(ctx, f.not, vars));
  if ('and' in f) return ctx.And(...f.and.map((x) => translate(ctx, x, vars)));
  return ctx.Or(...f.or.map((x) => translate(ctx, x, vars)));
}

/** A `SatSolver` over the official Z3 WebAssembly build, or `undefined` when `z3-solver` is not installed. */
export async function z3Solver(): Promise<SatSolver | undefined> {
  loading ??= load();
  const loaded = await loading;
  if (loaded === undefined) return undefined;
  const { ctx } = loaded;
  return {
    async solve(defs, formulas) {
      const solver = new ctx.Solver();
      const vars = new Map<string, BoolExpr>();
      for (const [name, f] of defs) solver.add(translate(ctx, { var: name }, vars).eq(translate(ctx, f, vars)));
      for (const f of formulas) solver.add(translate(ctx, f, vars));
      const answer = await solver.check();
      if (answer === 'unknown') throw new Unsupported(`z3 answered unknown: ${solver.reasonUnknown()}`);
      if (answer === 'unsat') return undefined;
      const model = solver.model();
      return new Set([...vars].filter(([, v]) => ctx.isTrue(model.eval(v, true))).map(([name]) => name));
    },
  };
}

/** Stops Z3's worker threads, which otherwise keep a Node process alive; the next query loads Z3 again. */
export async function releaseZ3(): Promise<void> {
  const loaded = await loading;
  loading = undefined;
  if (loaded !== undefined) await loaded.z3.killThreads(loaded.api.em);
}
