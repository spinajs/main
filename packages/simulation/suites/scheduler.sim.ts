import { v4 as uuidv4 } from 'uuid';
import { DI } from '@spinajs/di';
import '@spinajs/queue';
import { defineSchedule, isTerminalStatus, RunModel, ScheduledTask, Scheduler, undefineSchedule, type RunContext, type RunStatus } from '@spinajs/scheduler';
import { currentReplicaId, ensure, invariant, overLimit, runInContext, WriteOnceLedger, type FaultRule, type SimActor, type SimEnv, type SimSuite, type SimSystem } from '../src/index.js';

const SCHEDULE = 'sim-every-10s';
const LEASE_TTL = 30_000;
const REPLICAS = ['sched-1', 'sched-2', 'sched-3'];

interface RunRow {
  Id: string;
  Trigger: string;
  ScheduledAt: number | null;
  Status: RunStatus;
  Attempt: number;
  LeaseOwner: string | null;
  CreatedAt: number;
}

interface AttemptRow {
  RunId: string;
  Attempt: number;
  Status: RunStatus;
}

interface EffectRow {
  RunId: string;
  Attempt: number;
  Phase: 'start' | 'end';
  Replica: string;
  Owner: string | null;
}

export interface SchedulerSuiteOptions {
  /** Self-test: a second run per occurrence, written without the schedule lease. */
  rogue?: boolean;
  /** Self-test: an end row for a running attempt, written by a replica that never held its lease. */
  usurper?: boolean;
  /** Binds a ReplicaRouter whose only replica is an empty file; needs Bet 3 O10. */
  replicaRouter?: boolean;
  faults?: FaultRule[];
}

let current: SimEnv | undefined;

/** Scheduled work that outlives the tick which started it, so its heartbeat renews the lease. */
class SimScheduledWork extends ScheduledTask {
  public async execute(ctx: RunContext): Promise<string> {
    const env = current!;
    const db = env.database.driver;
    const effect = (phase: 'start' | 'end', owner: string | null) =>
      db.insert().into('sim_sched_effect').values({ RunId: ctx.runId, Attempt: ctx.attempt, Phase: phase, Replica: currentReplicaId(), Owner: owner });
    // the owner the run row shows while this body holds the lease; fenced-finalization compares every later owner with it
    const [run] = await db.select<Array<{ LeaseOwner: string | null }>>().from('__scheduler_run').where('Id', ctx.runId).where('Attempt', ctx.attempt);
    await effect('start', run?.LeaseOwner ?? null);
    await env.clock.sleep(1_000 + env.random.int(20_000), ctx.signal);
    await effect('end', null);
    return 'done';
  }
}

export const SCHEDULER_FAULTS: FaultRule[] = [
  { point: 'scheduler.lease-renew', when: { probability: 0.05 }, effect: 'crash' },
  { point: 'scheduler.lease-renew', when: { probability: 0.05 }, effect: 'delay', delayMs: LEASE_TTL + 5_000 },
];

export function schedulerSuite(o: SchedulerSuiteOptions = {}): SimSuite {
  // Bet 3 O10 (v4-o-10-replicas) brings ReplicaRouter; until then the smoke case in test/scheduler.sim.test.ts is pending
  if (o.replicaRouter) throw new Error('schedulerSuite: replicaRouter needs ReplicaRouter from @spinajs/orm (Bet 3 O10)');
  return {
    name: 'scheduler',
    steps: 200,
    options: { faults: o.faults ?? SCHEDULER_FAULTS, pausableReplicas: REPLICAS, maxPauseMs: 3 * LEASE_TTL },
    build: (env) => buildScheduler(env, o),
  };
}

export const SCHEDULER_SUITE = schedulerSuite();

async function buildScheduler(env: SimEnv, o: SchedulerSuiteOptions): Promise<SimSystem> {
  current = env;
  defineSchedule(SimScheduledWork, SCHEDULE, { every: '10s', retry: { attempts: 5, backoff: 'fixed', delay: '1s' } });
  try {
    await env.boot({
      template: 'scheduler',
      aliases: ['queue'],
      config: {
        queue: { default: 'black-hole', connections: [{ name: 'black-hole', service: 'BlackHoleQueueClient' }] },
        // shutdownGrace is wall-clock time SchedulerSignals.drain() may wait on dispose; 50 ms keeps a disposed incarnation cheap
        scheduler: { enabled: true, tick: 1000, leaseTtl: LEASE_TTL, shutdownGrace: 50, progressFlush: 5000, schedules: [], retention: { enabled: false } },
      },
    });
  } catch (err) {
    undefineSchedule(SCHEDULE);
    throw err;
  }
  const db = env.database.driver;
  await db.schema().createTable('sim_sched_effect', (t) => {
    t.int('Id').primaryKey().autoIncrement();
    t.string('RunId', 36).notNull();
    t.int('Attempt').notNull();
    t.string('Phase', 8).notNull();
    t.string('Replica', 32).notNull();
    t.string('Owner', 128);
  });

  const schedulers = new Map<string, Scheduler>();
  const start = async (replica: string): Promise<void> => {
    schedulers.set(replica, await DI.resolve(Scheduler, [{ replicaId: currentReplicaId(), autoStart: false }]));
  };
  for (const replica of REPLICAS) await runInContext(env.replicas.context(replica), () => start(replica));

  const runs = async (): Promise<RunRow[]> => await db.select<RunRow[]>().from('__scheduler_run').where('Schedule', SCHEDULE);
  const effects = async (ids: Set<string>): Promise<EffectRow[]> => (await db.select<EffectRow[]>().from('sim_sched_effect')).filter((e) => ids.has(e.RunId));
  const actors: SimActor[] = REPLICAS.map((name) => ({ name, replica: name, tick: () => schedulers.get(name)!.tickOnce(), restart: () => start(name) }));
  if (o.rogue) {
    // self-test only: records a second run for an occurrence without taking the schedule lease
    actors.push({
      name: 'rogue',
      replica: 'rogue',
      tick: async () => {
        const fired = (await runs()).filter((r) => r.Trigger === 'schedule' && r.ScheduledAt !== null);
        const last = fired.sort((a, b) => b.CreatedAt - a.CreatedAt)[0];
        if (!last) return;
        await RunModel.create({ Id: uuidv4(), Schedule: SCHEDULE, Trigger: 'schedule', Status: 'skipped', Attempt: 1, MaxAttempts: 1, CreatedAt: env.clock.now(), ScheduledAt: last.ScheduledAt, Progress: 0, CancelRequested: false, Forced: false });
      },
      restart: () => Promise.resolve(),
    });
  }
  if (o.usurper) {
    // self-test only: finishes a running attempt under a replica id that never held its lease
    actors.push({
      name: 'usurper',
      replica: 'usurper',
      tick: async () => {
        const [victim] = (await runs()).filter((r) => r.Status === 'running');
        if (victim) await db.insert().into('sim_sched_effect').values({ RunId: victim.Id, Attempt: victim.Attempt, Phase: 'end', Replica: currentReplicaId(), Owner: null });
      },
      restart: () => Promise.resolve(),
    });
  }

  const owners = new WriteOnceLedger();
  const outcomes = new WriteOnceLedger();
  return {
    actors,
    invariants: [
      invariant('occurrence-fired-once', async () => {
        const fired = (await runs()).filter((r) => r.Trigger === 'schedule' && r.ScheduledAt !== null);
        const twice = overLimit(fired, (r) => String(r.ScheduledAt));
        ensure(twice.length === 0, 'an occurrence produced more than one run', twice);
      }),
      invariant('fenced-finalization', async () => {
        const all = await runs();
        const ids = new Set(all.map((r) => r.Id));
        const rows = await effects(ids);
        // (Id, Attempt) -> LeaseOwner is written once: claiming a retrying run bumps Attempt (LeaseStore.claimRun), so an attempt never changes hands
        for (const r of all) if (r.LeaseOwner !== null) owners.observe(`${r.Id}#${r.Attempt}`, r.LeaseOwner);
        for (const e of rows) if (e.Phase === 'start' && e.Owner !== null) owners.observe(`${e.RunId}#${e.Attempt}`, e.Owner);
        // (RunId, Attempt) -> terminal Status is written once: a reaped attempt stays reaped when its stale body finishes
        const attempts = (await db.select<AttemptRow[]>().from('__scheduler_run_attempt')).filter((a) => ids.has(a.RunId));
        for (const a of attempts) if (isTerminalStatus(a.Status)) outcomes.observe(`${a.RunId}#${a.Attempt}`, a.Status);
        const foreign = rows.filter((e) => owners.value(`${e.RunId}#${e.Attempt}`) !== e.Replica).map((e) => `${e.RunId}#${e.Attempt}:${e.Phase}@${e.Replica}`);
        ensure(foreign.length === 0, 'an attempt ran or finished on a replica that never held its lease', foreign);
      }),
      invariant(
        'no-run-left-behind',
        async () => {
          const horizon = env.clock.now() - 4 * LEASE_TTL;
          const stuck = (await runs()).filter((r) => r.CreatedAt < horizon && !isTerminalStatus(r.Status));
          ensure(stuck.length === 0, 'runs still unfinished long after quiescence', stuck.map((r) => `${r.Id}:${r.Status}#${r.Attempt}`));
        },
        { final: true },
      ),
    ],
    workload: () => Promise.resolve(),
    dispose: () => {
      undefineSchedule(SCHEDULE);
      current = undefined;
      return Promise.resolve();
    },
  };
}
