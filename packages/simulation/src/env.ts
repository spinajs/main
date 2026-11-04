import { SimClock } from './clock.js';
import { currentContext, type SimContext } from './context.js';
import { SimFaults, type FaultRuntime } from './faults.js';
import { SimRandom } from './random.js';
import { SimReplicas } from './replicas.js';
import type { ResolvedSimulationOptions } from './simulate.js';

export interface SimEnv {
  readonly seed: number;
  readonly clock: SimClock;
  readonly random: SimRandom;
  readonly faults: SimFaults;
  readonly replicas: SimReplicas;
  /** True once the steps are done: faults are off and actors stop creating new work. */
  readonly quiescing: boolean;
  /** Pauses the calling replica for `ms` of simulated time (a GC pause); a no-op outside a replica or while quiescing. */
  park(ms: number): Promise<void>;
  /** Resolves when no async work started by the last tick or timer is still running. */
  settle(): Promise<void>;
  /** Releases what the environment opened; returns the kept database file, if any. */
  shutdown(keepDatabase: boolean): Promise<string | undefined>;
}

export interface MutableSimEnv extends SimEnv {
  quiescing: boolean;
  /** Set by the harness; the fault runtime calls it for every crash, wherever the crash was raised. */
  onCrash?: (ctx: SimContext) => void;
}

export function createEnv(o: ResolvedSimulationOptions): MutableSimEnv {
  const clock = new SimClock();
  const random = new SimRandom(o.seed);
  // its own stream: editing the rule set must not reshuffle the harness's actor and pause choices
  const faults = new SimFaults(o.faults, new SimRandom(o.seed ^ 0x9e3779b9));
  const replicas = new SimReplicas(clock);
  const runtime: FaultRuntime = {
    now: () => clock.now(),
    isDead: (ctx) => replicas.isDead(ctx),
    crash: (ctx) => {
      if (replicas.isDead(ctx)) return;
      replicas.crash(ctx);
      // traced here: production code may swallow the SimCrash (Heartbeat.enqueue().catch does)
      env.onCrash?.(ctx);
    },
    park: (ctx, ms) => replicas.park(ctx, ms),
  };
  faults.attach(runtime);
  const env: MutableSimEnv = {
    seed: o.seed,
    clock,
    random,
    faults,
    replicas,
    quiescing: false,
    park: (ms) => {
      const ctx = currentContext();
      return ctx && !env.quiescing ? runtime.park(ctx, ms) : Promise.resolve();
    },
    settle: flushTurns,
    shutdown: () => Promise.resolve(undefined),
  };
  return env;
}

/** Three macrotask turns: enough for promise chains without I/O to run to their end. */
async function flushTurns(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
