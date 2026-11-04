import type { Arith, Bool, Context } from 'z3-solver';

import { Unsupported } from './formula.js';
import type { Formula, Term } from './formula.js';
import type { SatSolver } from './solve.js';

type Z3Module = typeof import('z3-solver');
type Z3Api = Awaited<ReturnType<Z3Module['init']>>;
type Z3Context = Context<'main'>;
type BoolExpr = Bool<'main'>;
type ArithExpr = Arith<'main'>;

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

class Translator {
  readonly bools = new Map<string, BoolExpr>();
  readonly numbers = new Map<string, ArithExpr>();

  constructor(private readonly ctx: Z3Context) {}

  formula(f: Formula): BoolExpr {
    const ctx = this.ctx;
    if (typeof f === 'boolean') return ctx.Bool.val(f);
    if ('var' in f) return this.bool(f.var);
    if ('not' in f) return ctx.Not(this.formula(f.not));
    if ('and' in f) return ctx.And(...f.and.map((x) => this.formula(x)));
    if ('or' in f) return ctx.Or(...f.or.map((x) => this.formula(x)));
    const real = isReal(f.a) || isReal(f.b);
    const [a, b] = [this.term(f.a, real), this.term(f.b, real)];
    return f.cmp === 'eq' ? a.eq(b) : f.cmp === 'lt' ? a.lt(b) : a.le(b);
  }

  private bool(name: string): BoolExpr {
    let v = this.bools.get(name);
    if (v === undefined) {
      v = this.ctx.Bool.const(name);
      this.bools.set(name, v);
    }
    return v;
  }

  private term(t: Term, real: boolean): ArithExpr {
    const ctx = this.ctx;
    if (typeof t === 'number') return real || !Number.isInteger(t) ? ctx.Real.val(t) : ctx.Int.val(t);
    let v = this.numbers.get(t.num);
    if (v === undefined) {
      v = t.real === true ? ctx.Real.const(t.num) : ctx.Int.const(t.num);
      this.numbers.set(t.num, v);
    }
    return real && t.real !== true ? ctx.ToReal(v) : v;
  }
}

const isReal = (t: Term): boolean => (typeof t === 'number' ? !Number.isInteger(t) : t.real === true);

/** A `SatSolver` over the official Z3 WebAssembly build, or `undefined` when `z3-solver` is not installed. */
export async function z3Solver(): Promise<SatSolver | undefined> {
  loading ??= load();
  const loaded = await loading;
  if (loaded === undefined) return undefined;
  const { ctx } = loaded;
  return {
    async solve(defs, formulas) {
      const solver = new ctx.Solver();
      const t = new Translator(ctx);
      for (const [name, f] of defs) solver.add(t.formula({ var: name }).eq(t.formula(f)));
      for (const f of formulas) solver.add(t.formula(f));
      const answer = await solver.check();
      if (answer === 'unknown') throw new Unsupported(`z3 answered unknown: ${solver.reasonUnknown()}`);
      if (answer === 'unsat') return undefined;
      const model = solver.model();
      const holds = new Set([...t.bools].filter(([, v]) => ctx.isTrue(model.eval(v, true))).map(([name]) => name));
      const values = new Map<string, number>();
      for (const [name, v] of t.numbers) {
        const value = model.eval(v, true);
        if (ctx.isIntVal(value)) values.set(name, Number(value.value()));
        else if (ctx.isRealVal(value)) values.set(name, value.asNumber());
      }
      return { holds, values };
    },
  };
}

/** Stops Z3's worker threads, which otherwise keep a Node process alive; the next query loads Z3 again. */
export async function releaseZ3(): Promise<void> {
  const loaded = await loading;
  loading = undefined;
  if (loaded !== undefined) await loaded.z3.killThreads(loaded.api.em);
}
