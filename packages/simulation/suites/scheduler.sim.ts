import { v4 as uuidv4 } from 'uuid';
import { DI } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';
import '@spinajs/queue';
import { defineSchedule, isTerminalStatus, RunModel, ScheduledTask, Scheduler, TERMINAL_RUN_STATUSES, undefineSchedule, type RunContext, type RunStatus } from '@spinajs/scheduler';
import { currentReplicaId, ensure, invariant, overLimit, runInContext, WriteOnceLedger, type FaultRule, type SimActor, type SimEnv, type SimInvariant, type SimSuite, type SimSystem } from '../src/index.js';

const SCHEDULE = 'sim-every-10s';
const LEASE_TTL = 30_000;
const REPLICAS = ['sched-1', 'sched-2', 'sched-3'];
const BODY_PAUSE_PROBABILITY = 0.15;

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

interface FenceLogRow {
  Kind: string;
  RunId: string;
  Attempt: number;
  OldValue: string | null;
  NewValue: string | null;
}

export interface SchedulerSeedStats {
  /** Run bodies paused past the lease. */
  bodyPauses: number;
  /** Bodies that returned after their attempt was reaped or re-claimed; the fence must refuse their finishRun. */
  staleFinishes: number;
}

export interface SchedulerSuiteOptions {
  /** Self-test: a second run per occurrence, written without the schedule lease. */
  rogue?: boolean;
  /** Self-test: an end row for a running attempt, written by a replica that never held its lease. */
  usurper?: boolean;
  /** Self-test: rewrites the outcome of a finished attempt. */
  resurrector?: boolean;
  /** Binds a ReplicaRouter whose only replica is an empty file; needs Bet 3 O10. */
  replicaRouter?: boolean;
  faults?: FaultRule[];
  /** Receives the stats of each seed when it is disposed. */
  observe?: (stats: SchedulerSeedStats) => void;
}

let current: { env: SimEnv; stats: SchedulerSeedStats } | undefined;

/** Scheduled work that outlives the tick which started it, so its heartbeat renews the lease. */
class SimScheduledWork extends ScheduledTask {
  public async execute(ctx: RunContext): Promise<string> {
    const { env, stats } = current!;
    const db = env.database.driver;
    const replica = currentReplicaId();
    const runRow = async () => (await db.select<RunRow[]>().from('__scheduler_run').where('Id', ctx.runId))[0];
    const effect = (phase: 'start' | 'end', owner: string | null) => db.insert().into('sim_sched_effect').values({ RunId: ctx.runId, Attempt: ctx.attempt, Phase: phase, Replica: replica, Owner: owner });
    // the owner the run row shows while this body holds the lease; fenced-finalization compares every later owner with it
    const claimed = await runRow();
    await effect('start', claimed?.Attempt === ctx.attempt ? claimed.LeaseOwner : null);
    await env.clock.sleep(1_000 + env.random.int(20_000), ctx.signal);
    if (!env.quiescing && env.random.chance(BODY_PAUSE_PROBABILITY)) {
      stats.bodyPauses++;
      // a thaw resumes this park before the replica's overdue heartbeat fires, so the body returns into a reaped attempt
      await env.park(LEASE_TTL + 5_000 + env.random.int(20_000));
    }
    const row = await runRow();
    // an aborted body never reaches finishRun; a live one does, with nothing else running in between
    if (!ctx.signal.aborted && (row?.Status !== 'running' || row.Attempt !== ctx.attempt || row.LeaseOwner !== replica)) stats.staleFinishes++;
    await effect('end', null);
    return 'done';
  }
}

export const SCHEDULER_FAULTS: FaultRule[] = [
  { point: 'scheduler.lease-renew', when: { probability: 0.15 }, effect: 'crash' },
  { point: 'scheduler.lease-renew', when: { probability: 0.15 }, effect: 'delay', delayMs: LEASE_TTL + 5_000 },
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

const TERMINAL_SQL = TERMINAL_RUN_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * Triggers log every write that rewrites a finished outcome or hands an attempt to another owner, so an
 * unfenced write is caught even when a later write hides it before the next check.
 */
const FENCE_TRIGGERS = [
  `CREATE TRIGGER sim_sched_attempt_outcome AFTER UPDATE OF Status ON __scheduler_run_attempt WHEN OLD.Status IN (${TERMINAL_SQL}) AND NEW.Status IS NOT OLD.Status
   BEGIN INSERT INTO sim_sched_fence_log (Kind, RunId, Attempt, OldValue, NewValue) VALUES ('attempt-outcome', OLD.RunId, OLD.Attempt, OLD.Status, NEW.Status); END`,
  `CREATE TRIGGER sim_sched_run_outcome AFTER UPDATE OF Status ON __scheduler_run WHEN OLD.Status IN (${TERMINAL_SQL}) AND NEW.Status IS NOT OLD.Status
   BEGIN INSERT INTO sim_sched_fence_log (Kind, RunId, Attempt, OldValue, NewValue) VALUES ('run-outcome', OLD.Id, OLD.Attempt, OLD.Status, NEW.Status); END`,
  // claiming a retrying run bumps Attempt (LeaseStore.claimRun), so an attempt never passes from one owner to another
  `CREATE TRIGGER sim_sched_run_owner AFTER UPDATE OF LeaseOwner ON __scheduler_run WHEN OLD.LeaseOwner IS NOT NULL AND NEW.LeaseOwner IS NOT NULL AND NEW.LeaseOwner <> OLD.LeaseOwner AND NEW.Attempt = OLD.Attempt
   BEGIN INSERT INTO sim_sched_fence_log (Kind, RunId, Attempt, OldValue, NewValue) VALUES ('run-owner', OLD.Id, OLD.Attempt, OLD.LeaseOwner, NEW.LeaseOwner); END`,
];

async function createSideTables(env: SimEnv): Promise<void> {
  const db = env.database.driver;
  await db.schema().createTable('sim_sched_effect', (t) => {
    t.int('Id').primaryKey().autoIncrement();
    t.string('RunId', 36).notNull();
    t.int('Attempt').notNull();
    t.string('Phase', 8).notNull();
    t.string('Replica', 32).notNull();
    t.string('Owner', 128);
  });
  await db.schema().createTable('sim_sched_fence_log', (t) => {
    t.int('Id').primaryKey().autoIncrement();
    t.string('Kind', 16).notNull();
    t.string('RunId', 36).notNull();
    t.int('Attempt').notNull();
    t.string('OldValue', 128);
    t.string('NewValue', 128);
  });
  for (const sql of FENCE_TRIGGERS) await env.database.execute(sql);
}

async function bootScheduler(env: SimEnv): Promise<void> {
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
}

async function buildScheduler(env: SimEnv, o: SchedulerSuiteOptions): Promise<SimSystem> {
  const stats: SchedulerSeedStats = { bodyPauses: 0, staleFinishes: 0 };
  current = { env, stats };
  await bootScheduler(env);
  await createSideTables(env);
  const db = env.database.driver;

  const schedulers = new Map<string, Scheduler>();
  const start = async (replica: string): Promise<void> => {
    schedulers.set(replica, await DI.resolve(Scheduler, [{ replicaId: currentReplicaId(), autoStart: false }]));
  };
  for (const replica of REPLICAS) await runInContext(env.replicas.context(replica), () => start(replica));

  const runs = async (): Promise<RunRow[]> => await db.select<RunRow[]>().from('__scheduler_run').where('Schedule', SCHEDULE);
  const unfinished = async (): Promise<RunRow[]> => {
    const horizon = env.clock.now() - 4 * LEASE_TTL;
    return (await runs()).filter((r) => r.CreatedAt < horizon && !isTerminalStatus(r.Status));
  };
  const actors: SimActor[] = REPLICAS.map((name) => ({ name, replica: name, tick: () => schedulers.get(name)!.tickOnce(), restart: () => start(name) }));
  actors.push(...selfTestActors(env, o, runs));

  return {
    actors,
    invariants: schedulerInvariants(db, runs, unfinished),
    workload: () => Promise.resolve(),
    quiesced: async () => (await unfinished()).length === 0,
    dispose: () => {
      undefineSchedule(SCHEDULE);
      current = undefined;
      o.observe?.(stats);
      return Promise.resolve();
    },
  };
}

function selfTestActor(name: string, tick: () => Promise<void>): SimActor {
  return { name, replica: name, tick, restart: () => Promise.resolve() };
}

function selfTestActors(env: SimEnv, o: SchedulerSuiteOptions, runs: () => Promise<RunRow[]>): SimActor[] {
  const db = env.database.driver;
  const actors: SimActor[] = [];
  if (o.rogue) {
    // records a second run for an occurrence without taking the schedule lease
    actors.push(
      selfTestActor('rogue', async () => {
        const fired = (await runs()).filter((r) => r.Trigger === 'schedule' && r.ScheduledAt !== null);
        const last = fired.sort((a, b) => b.CreatedAt - a.CreatedAt)[0];
        if (!last) return;
        await RunModel.create({ Id: uuidv4(), Schedule: SCHEDULE, Trigger: 'schedule', Status: 'skipped', Attempt: 1, MaxAttempts: 1, CreatedAt: env.clock.now(), ScheduledAt: last.ScheduledAt, Progress: 0, CancelRequested: false, Forced: false });
      }),
    );
  }
  if (o.usurper) {
    // finishes a running attempt under a replica id that never held its lease
    actors.push(
      selfTestActor('usurper', async () => {
        const [victim] = (await runs()).filter((r) => r.Status === 'running');
        if (victim) await db.insert().into('sim_sched_effect').values({ RunId: victim.Id, Attempt: victim.Attempt, Phase: 'end', Replica: currentReplicaId(), Owner: null });
      }),
    );
  }
  if (o.resurrector) {
    // rewrites a finished attempt's outcome, as an unfenced finishRun of a reaped body would
    actors.push(
      selfTestActor('resurrector', async () => {
        const [done] = (await db.select<AttemptRow[]>().from('__scheduler_run_attempt')).filter((a) => isTerminalStatus(a.Status));
        if (done) await env.database.execute('UPDATE __scheduler_run_attempt SET Status = ? WHERE RunId = ? AND Attempt = ?', [done.Status === 'succeeded' ? 'failed' : 'succeeded', done.RunId, done.Attempt]);
      }),
    );
  }
  return actors;
}

function schedulerInvariants(db: OrmDriver, runs: () => Promise<RunRow[]>, unfinished: () => Promise<RunRow[]>): SimInvariant[] {
  const effects = async (ids: Set<string>): Promise<EffectRow[]> => (await db.select<EffectRow[]>().from('sim_sched_effect')).filter((e) => ids.has(e.RunId));
  const attempts = async (ids: Set<string>): Promise<AttemptRow[]> => (await db.select<AttemptRow[]>().from('__scheduler_run_attempt')).filter((a) => ids.has(a.RunId));
  const owners = new WriteOnceLedger();
  return [
    invariant('occurrence-fired-once', async () => {
      const fired = (await runs()).filter((r) => r.Trigger === 'schedule' && r.ScheduledAt !== null);
      const twice = overLimit(fired, (r) => String(r.ScheduledAt));
      ensure(twice.length === 0, 'an occurrence produced more than one run', twice);
    }),
    invariant('fenced-finalization', async () => {
      const log = await db.select<FenceLogRow[]>().from('sim_sched_fence_log');
      ensure(log.length === 0, 'a finished outcome was rewritten or an attempt changed owner', log.map((l) => `${l.Kind} ${l.RunId}#${l.Attempt}: ${l.OldValue} -> ${l.NewValue}`));
      const all = await runs();
      const rows = await effects(new Set(all.map((r) => r.Id)));
      for (const r of all) if (r.LeaseOwner !== null) owners.observe(`${r.Id}#${r.Attempt}`, r.LeaseOwner);
      for (const e of rows) if (e.Phase === 'start' && e.Owner !== null) owners.observe(`${e.RunId}#${e.Attempt}`, e.Owner);
      const foreign = rows.filter((e) => owners.value(`${e.RunId}#${e.Attempt}`) !== e.Replica).map((e) => `${e.RunId}#${e.Attempt}:${e.Phase}@${e.Replica}`);
      ensure(foreign.length === 0, 'an attempt ran or finished on a replica that never held its lease', foreign);
    }),
    invariant(
      'finished-runs-match-attempts',
      async () => {
        const finished = (await runs()).filter((r) => isTerminalStatus(r.Status) && r.Status !== 'skipped' && r.Status !== 'misfired');
        const rows = await attempts(new Set(finished.map((r) => r.Id)));
        const mismatched = finished.filter((r) => {
          const own = rows.filter((a) => a.RunId === r.Id);
          return !own.every((a) => isTerminalStatus(a.Status)) || own.find((a) => a.Attempt === r.Attempt)?.Status !== r.Status;
        });
        ensure(mismatched.length === 0, "a finished run's attempts disagree with it", mismatched.map((r) => `${r.Id}:${r.Status}#${r.Attempt}`));
      },
      { final: true },
    ),
    invariant(
      'no-run-left-behind',
      async () => {
        const stuck = await unfinished();
        ensure(stuck.length === 0, 'runs still unfinished long after quiescence', stuck.map((r) => `${r.Id}:${r.Status}#${r.Attempt}`));
      },
      { final: true },
    ),
    invariant(
      'some-run-succeeded',
      async () => {
        const succeeded = (await runs()).filter((r) => r.Status === 'succeeded');
        const rows = await effects(new Set(succeeded.map((r) => r.Id)));
        const complete = succeeded.filter((r) => ['start', 'end'].every((phase) => rows.some((e) => e.RunId === r.Id && e.Attempt === r.Attempt && e.Phase === phase)));
        ensure(complete.length > 0, 'no run succeeded with both its start and end effect', { succeeded: succeeded.length });
      },
      { final: true },
    ),
  ];
}
