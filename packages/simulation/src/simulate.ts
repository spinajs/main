import { createEnv, type SimEnv } from './env.js';
import type { FaultHit, FaultRule } from './faults.js';
import { Harness } from './harness.js';
import type { SimInvariant } from './invariants.js';
import type { SimRandom } from './random.js';

export interface SimActor {
  name: string;
  replica: string;
  tick(): Promise<void>;
  /** Starts a new incarnation after a crash; runs in the new incarnation's context. */
  restart(): Promise<void>;
}

export interface SimSystem {
  actors: SimActor[];
  invariants: SimInvariant[];
  /** Runs outside every replica at the start of each step, eg. to start workflow instances. */
  workload(random: SimRandom, step: number): Promise<void>;
  /** Ends the quiescence phase early once it returns true. */
  quiesced?(): Promise<boolean>;
  dispose(): Promise<void>;
}

export interface SimulationOptions {
  seed: number;
  steps: number;
  faults: FaultRule[];
  pausableReplicas?: string[];
  maxClockStepMs?: number;
  /** Suite name used in the replay command of a failure. */
  suite?: string;
  checkEvery?: number;
  restartProbability?: number;
  pauseProbability?: number;
  maxPauseMs?: number;
  quiesceRounds?: number;
  /** Real milliseconds a tick may take before the run fails as stuck. */
  tickTimeoutMs?: number;
}

export type ResolvedSimulationOptions = Required<SimulationOptions>;

export type SimTraceAction = 'tick' | 'park' | 'resume' | 'crash' | 'restart' | 'down' | 'pause' | 'frozen' | 'idle';

export interface SimTraceEntry {
  step: number;
  at: number;
  actor: string;
  action: SimTraceAction;
}

export interface SimFailure {
  invariant: string;
  error: unknown;
  step: number;
  replay: string;
}

export interface SimReport {
  seed: number;
  steps: number;
  faults: FaultHit[];
  trace: SimTraceEntry[];
  failure?: SimFailure;
  /** The database file kept for inspection after a failure. */
  databaseFile?: string;
}

export function resolveOptions(o: SimulationOptions): ResolvedSimulationOptions {
  return {
    pausableReplicas: [],
    maxClockStepMs: 5_000,
    suite: 'unnamed',
    checkEvery: 10,
    restartProbability: 0.3,
    pauseProbability: 0.05,
    maxPauseMs: 120_000,
    quiesceRounds: 40,
    tickTimeoutMs: 15_000,
    ...o,
  };
}

export async function simulate(build: (env: SimEnv) => Promise<SimSystem>, options: SimulationOptions): Promise<SimReport> {
  const o = resolveOptions(options);
  const env = createEnv(o);
  const report: SimReport = { seed: o.seed, steps: 0, faults: env.faults.hits, trace: [] };
  const harness = new Harness(env, o, report);
  let system: SimSystem | undefined;
  try {
    system = await build(env);
    await harness.run(system);
  } catch (error) {
    report.failure = harness.failureOf(error);
  } finally {
    await harness.shutdown(system);
  }
  return report;
}
