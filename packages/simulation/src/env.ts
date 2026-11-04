import '@spinajs/log';
import '@spinajs/orm-sqlite';
import type { Class, IContainer } from '@spinajs/di';
import { Clock, DbTimeSource, FaultInjector } from '@spinajs/durable';
import { Orm, OrmMigrator } from '@spinajs/orm';
import { createTestApp, type TestApp } from '@spinajs/testing';
import { SimClock, SimDbTimeSource } from './clock.js';
import { currentContext, type SimContext } from './context.js';
import { SIM_CONNECTION, SimDatabase } from './database.js';
import { SimFaults, type FaultRuntime } from './faults.js';
import { SimRandom } from './random.js';
import { SimReplicas } from './replicas.js';
import type { ResolvedSimulationOptions } from './simulate.js';

const SILENT_LOGGER = {
  targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }],
  rules: [{ name: '*', level: 'error', target: 'Empty' }],
};

export interface SimBootOptions {
  /** Configuration besides `db` and `logger`, which the harness owns. */
  config: Record<string, unknown>;
  /** Logical connection names the booted packages use; all of them map onto the one simulated connection. */
  aliases?: string[];
  /** Key of a migrated database file that the next seeds of the same suite copy instead of migrating. */
  template?: string;
  register?: (container: IContainer) => void;
  resolve?: Array<Class<unknown>>;
}

export interface SimEnv {
  readonly seed: number;
  readonly clock: SimClock;
  readonly random: SimRandom;
  readonly faults: SimFaults;
  readonly replicas: SimReplicas;
  readonly database: SimDatabase;
  /** True once the steps are done: faults are off and actors stop creating new work. */
  readonly quiescing: boolean;
  /** Pauses the calling replica for `ms` of simulated time (a GC pause); a no-op outside a replica or while quiescing. */
  park(ms: number): Promise<void>;
  /** Resolves when no async work started by the last tick or timer is still running. */
  settle(): Promise<void>;
  /** Boots the app of this seed in the root container, on the simulated database. */
  boot(options: SimBootOptions): Promise<TestApp>;
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
  const database = new SimDatabase(o.seed, replicas);
  let app: TestApp | undefined;
  const runtime: FaultRuntime = {
    now: () => clock.now(),
    isDead: (ctx) => replicas.isDead(ctx),
    crash: (ctx) => {
      if (replicas.isDead(ctx)) return;
      replicas.crash(ctx);
      // traced here: production code may swallow the SimCrash (Heartbeat.enqueue().catch does)
      env.onCrash?.(ctx);
    },
    park: (ctx, ms) => {
      if (!database.inTransaction()) return replicas.park(ctx, ms);
      // yielding here would hold the only sqlite writer: the pause runs when the outermost transaction() resolves
      replicas.deferPark(ctx, ms);
      return Promise.resolve();
    },
  };
  faults.attach(runtime);
  const env: MutableSimEnv = {
    seed: o.seed,
    clock,
    random,
    faults,
    replicas,
    database,
    quiescing: false,
    park: (ms) => {
      const ctx = currentContext();
      return ctx && !env.quiescing ? runtime.park(ctx, ms) : Promise.resolve();
    },
    settle: () => database.idle(),
    boot: async (options) => {
      if (app) throw new Error('SimEnv.boot: this seed is already booted');
      database.prepare(options.template);
      app = await createTestApp({
        name: `simulation ${o.suite} seed ${o.seed}`,
        bootTimeout: 0,
        config: { ...options.config, logger: SILENT_LOGGER, db: database.config(options.aliases ?? []) },
        register: (container) => {
          container.register(() => clock).as(Clock);
          container.register(() => new SimDbTimeSource(clock)).as(DbTimeSource);
          container.register(() => faults).as(FaultInjector);
          options.register?.(container);
        },
        resolve: [OrmMigrator, ...(options.resolve ?? [])],
      });
      const orm = await app.resolve(Orm);
      const driver = orm.Connections.get(SIM_CONNECTION);
      if (!driver) throw new Error(`SimEnv.boot: the ${SIM_CONNECTION} connection did not open`);
      database.attach(driver);
      await database.saveTemplate(options.template);
      return app;
    },
    shutdown: async (keep) => {
      try {
        await app?.dispose();
      } finally {
        app = undefined;
      }
      return database.close(keep);
    },
  };
  return env;
}
