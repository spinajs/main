import * as fc from 'fast-check';
import type { Vote } from '@spinajs/authz';
import { IREvaluator } from '@spinajs/authz-ir';
import type { EvalInput, IREvaluatorOptions, PolicyIR, Truth, TupleSource } from '@spinajs/authz-ir';

/** One generated world: the IR of the models, the data both sides read, the requests to compare and the engine's answer. */
export interface AgreementWorld {
  readonly ir: PolicyIR;
  readonly tuples: TupleSource;
  readonly requests: readonly EvalInput[];
  engine(request: EvalInput): Promise<Truth>;
  dispose?(): Promise<void>;
}

export interface IrAgreementOptions extends Pick<IREvaluatorOptions, 'maxDepth' | 'maxCalls' | 'functions'> {
  /** Default `AUTHZ_IR_AGREEMENT_RUNS`, else 300 (the PR setting; nightly runs 10000). */
  readonly numRuns?: number;
  /** Replays a failure fast-check printed. */
  readonly seed?: number;
}

/**
 * The three-valued answer of a vote on a concrete resource. An indeterminate vote (`error`: a limit, a store
 * failure, `model_error`) is `unknown`, which is what the IR evaluator answers past its limits.
 */
export function voteTruth(vote: Vote): Truth {
  if (vote.error !== undefined) return 'unknown';
  if (vote.denyWhen.op === 'true' || vote.permitWhen.op === 'false') return 'deny';
  return vote.permitWhen.op === 'true' && vote.denyWhen.op === 'false' ? 'allow' : 'unknown';
}

/**
 * Differential conformance (Z6): for every generated world, the engine and `IREvaluator.check` give the same
 * allow/deny/unknown on every request. A disagreement fails with fast-check's shrunk counterexample and the seed
 * that replays it.
 */
export async function irAgreement<T>(arbitrary: fc.Arbitrary<T>, build: (value: T) => AgreementWorld | Promise<AgreementWorld>, options: IrAgreementOptions = {}): Promise<void> {
  const numRuns = options.numRuns ?? (Number(process.env.AUTHZ_IR_AGREEMENT_RUNS) || 300);
  const { seed, ...evaluator } = options;
  await fc.assert(
    fc.asyncProperty(arbitrary, async (value) => {
      const world = await build(value);
      try {
        const ir = new IREvaluator(world.ir, world.tuples, evaluator);
        for (const request of world.requests) {
          const engine = await world.engine(request);
          const { truth } = await ir.check(request);
          if (engine !== truth) throw new Error(`engine answers ${engine}, the IR ${truth}: ${JSON.stringify(request)}`);
        }
      } finally {
        await world.dispose?.();
      }
    }),
    { numRuns, ...(seed === undefined ? {} : { seed }) },
  );
}
