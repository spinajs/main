import { DI } from '@spinajs/di';
import '@spinajs/queue';
import { branchId, branchOfKey, COMPENSATION_SEQ_BASE, Workflow, WorkflowDefinition, WorkflowEngine, WorkflowService, type WorkflowContext } from '@spinajs/workflow';
import { countBy, currentReplicaId, ensure, invariant, overLimit, runInContext, WriteOnceLedger, type FaultRule, type SimActor, type SimEnv, type SimSuite, type SimSystem } from '../src/index.js';

const ENGINES = ['engine-1', 'engine-2', 'engine-3'];
const LEASE_TTL = 30_000;
const MAX_INSTANCES = 8;
const P1 = branchId('', 'step:pick#1');
const P2 = branchId('', 'step:pick#2');
/** The key each call number of a branch must hold. A journal may lack a call (a crash, a step still running), never hold another key there. */
const EXPECTED = new Map<string, string[]>([
  ['', ['step:reserve#1', 'step:pick#1', 'step:pick#2']],
  [P1, [`step:pack#1@${P1}`]],
  [P2, [`step:pack#1@${P2}`, `sleep:cool-off#1@${P2}`, `wait:approve#1@${P2}`, `step:charge#1@${P2}`, `step:ship#1@${P2}`]],
]);
/** What the fan-out rows must hold: a replay that hands a branch its sibling's result keeps every key in its slot. */
const FAN_OUT_RESULTS = new Map<string, string>([
  ['step:pick#1', 'a'],
  ['step:pick#2', 'b'],
  [`step:pack#1@${P1}`, 'packed a'],
  [`step:pack#1@${P2}`, 'packed b'],
]);
const OTHER_PART: Record<string, string> = { a: 'b', b: 'a' };
const CHARGE = `step:charge#1@${P2}`;
const COMPENSABLE = new Set(['step:reserve#1', CHARGE]);
const TRANSACTIONAL = new Set([CHARGE, `step:ship#1@${P2}`]);
const TERMINAL = ['completed', 'failed', 'compensated', 'cancelled'];

/** What a self-test breaks behind the engine's back; each kind is caught by one invariant (test/workflow.sim.test.ts). */
export type WorkflowTamper = 'result' | 'call' | 'swap' | 'drift' | 'compensation-order' | 'compensation-effect' | 'effect' | 'consume' | 'stall' | 'status';

export interface WorkflowSuiteOptions {
  tamper?: WorkflowTamper;
  /** Share of instances whose input tells them to fail after the charge; default 0.3. */
  failRate?: number;
  faults?: FaultRule[];
}

interface StepRow {
  InstanceId: string;
  Seq: number;
  Key: string;
  Kind: string;
  Status: string;
  Result: string | null;
  Meta: string | null;
}

interface InstanceRow {
  Id: string;
  Status: string;
  Reason: string | null;
  Result: string | null;
}

interface EventRow {
  Id: number;
  InstanceId: string;
  State: string;
  ConsumedByKey: string | null;
}

interface EffectRow {
  InstanceId: string;
  Step: string;
}

interface Seed {
  env: SimEnv;
  /** Self-test `drift`: an instance asks for another step name from its second activation on. */
  drift: boolean;
  /** Self-test `swap`: each branch packs the other branch's part, as a replay that hands it the other's result would. */
  swap: boolean;
  activated: Set<string>;
}

let current: Seed | undefined;

/** The seed being simulated; `SimOrderWorkflow` is a module-level class and reaches it through here. */
function seed(): Seed {
  if (!current) throw new Error('the workflow suite is not built: SimOrderWorkflow runs only inside a simulated seed');
  return current;
}

const metaOf = (row: StepRow): { order?: number; call?: number } => (row.Meta ? (JSON.parse(row.Meta) as { order?: number; call?: number }) : {});
const waitOf = (e: EventRow): string => `${e.InstanceId}|${e.ConsumedByKey}`;

async function effect(table: 'sim_wf_effect' | 'sim_wf_compensation', instanceId: string, step: string): Promise<string> {
  await seed().env.database.driver.insert().into(table).values({ InstanceId: instanceId, Step: step, Replica: currentReplicaId() });
  return step;
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

@Workflow('sim-order', { version: 1, retry: { attempts: 3, backoff: 'fixed', delay: 1_000 } })
export class SimOrderWorkflow extends WorkflowDefinition<{ fail: boolean }, string> {
  public async run(ctx: WorkflowContext<{ fail: boolean }>): Promise<string> {
    const { drift, swap, activated } = seed();
    const pack = drift && activated.has(ctx.instanceId) ? 'wrap' : 'pack';
    activated.add(ctx.instanceId);
    await ctx.step('reserve', () => effect('sim_wf_effect', ctx.instanceId, 'reserve'), {
      compensate: async () => {
        await effect('sim_wf_compensation', ctx.instanceId, 'reserve');
      },
    });
    await Promise.all(
      ['a', 'b'].map(async (part) => {
        await ctx.step('pick', () => part);
        // a non-durable await between same-name steps of concurrent branches: the case branch-lineage keys exist for
        await nextTurn();
        await ctx.step(pack, () => `packed ${swap ? OTHER_PART[part] : part}`);
      }),
    );
    await ctx.sleep('5s', 'cool-off');
    const approval = await ctx.waitForEvent<{ ok: boolean }>('approve', { timeout: '60s' });
    await ctx.step('charge', () => effect('sim_wf_effect', ctx.instanceId, 'charge'), {
      transactional: true,
      compensate: async () => {
        await effect('sim_wf_compensation', ctx.instanceId, 'charge');
      },
    });
    if (ctx.input.fail || !approval) ctx.fail(approval ? 'declined' : 'no-approval');
    await ctx.step('ship', () => effect('sim_wf_effect', ctx.instanceId, 'ship'), { transactional: true });
    return 'shipped';
  }
}

export const WORKFLOW_FAULTS: FaultRule[] = [
  { point: 'workflow.after-step-fn', when: { probability: 0.03 }, effect: 'crash' },
  { point: 'workflow.after-step-fn', when: { probability: 0.03 }, effect: 'delay', delayMs: LEASE_TTL + 5_000 },
  { point: 'workflow.before-journal', when: { probability: 0.03 }, effect: 'crash' },
  // the lease expires before an update of a row the new owner already wrote (a wait consuming a signal): only the epoch fence refuses it
  { point: 'workflow.before-journal', when: { probability: 0.03 }, effect: 'delay', delayMs: LEASE_TTL + 5_000 },
  { point: 'workflow.after-journal', when: { probability: 0.03 }, effect: 'crash' },
  // not reached yet: a paused replica's heartbeat does not fire, and after the thaw it marks the lease lost without renew()
  { point: 'workflow.lease-renew', when: { probability: 0.05 }, effect: 'crash' },
];

export function workflowSuite(o: WorkflowSuiteOptions = {}): SimSuite {
  return {
    name: 'workflow',
    steps: 250,
    options: { faults: o.faults ?? WORKFLOW_FAULTS, pausableReplicas: ENGINES, maxPauseMs: 3 * LEASE_TTL },
    build: (env) => buildWorkflow(env, o),
  };
}

export const WORKFLOW_SUITE = workflowSuite();

function byInstance(rows: StepRow[]): Map<string, StepRow[]> {
  const out = new Map<string, StepRow[]>();
  for (const row of [...rows].sort((a, b) => a.Seq - b.Seq)) out.set(row.InstanceId, [...(out.get(row.InstanceId) ?? []), row]);
  return out;
}

/** The self-test actor: one way of breaking the data per kind. `drift` and `swap` change the workflow's code instead, so they do nothing here. */
function tamperActor(env: SimEnv, kind: WorkflowTamper, steps: () => Promise<StepRow[]>): SimActor {
  const db = env.database;
  let done = false;
  const once = async (work: () => Promise<boolean>): Promise<void> => {
    if (!done) done = await work();
  };
  const act: Record<WorkflowTamper, () => Promise<void>> = {
    result: async () => {
      const victim = (await steps()).find((s) => s.Status === 'succeeded' && s.Kind === 'step');
      if (victim) await db.execute('UPDATE __workflow_step SET Result = ? WHERE InstanceId = ? AND "Key" = ?', [JSON.stringify(`tampered@${env.clock.now()}`), victim.InstanceId, victim.Key]);
    },
    call: () =>
      once(async () => {
        const victim = (await steps()).find((s) => s.Key === 'step:reserve#1');
        if (!victim) return false;
        await db.execute('UPDATE __workflow_step SET Meta = ? WHERE InstanceId = ? AND "Key" = ?', [JSON.stringify({ ...metaOf(victim), call: 9 }), victim.InstanceId, victim.Key]);
        return true;
      }),
    swap: () => Promise.resolve(),
    drift: () => Promise.resolve(),
    'compensation-order': () =>
      once(async () => {
        if (!(await steps()).some((s) => s.Kind === 'compensate')) return false;
        await db.execute("UPDATE __workflow_step SET Seq = Seq + 7 WHERE Kind = 'compensate'");
        return true;
      }),
    'compensation-effect': () =>
      once(async () => {
        if (!(await steps()).some((s) => s.Kind === 'compensate' && s.Status === 'succeeded')) return false;
        await db.execute('DELETE FROM sim_wf_compensation');
        return true;
      }),
    effect: () =>
      once(async () => {
        const charged = (await steps()).find((s) => s.Key === CHARGE && s.Status === 'succeeded');
        if (!charged) return false;
        await db.driver.insert().into('sim_wf_effect').values({ InstanceId: charged.InstanceId, Step: 'charge', Replica: 'tamper' });
        return true;
      }),
    consume: () =>
      once(async () => {
        const events = await db.driver.select<EventRow[]>().from('__workflow_event');
        const taken = events.filter((e) => e.State === 'consumed');
        const spare = events.find((e) => e.State === 'pending' && taken.some((t) => t.InstanceId === e.InstanceId));
        const first = spare && taken.find((t) => t.InstanceId === spare.InstanceId);
        if (!spare || !first) return false;
        await db.execute('UPDATE __workflow_event SET State = ?, ConsumedByKey = ? WHERE Id = ?', ['consumed', first.ConsumedByKey, spare.Id]);
        return true;
      }),
    stall: () =>
      once(async () => {
        const now = env.clock.now();
        // a version nobody registered: the engines leave it alone, so it never ends
        await db.driver.insert().into('__workflow').values({ Id: 'wf-stalled', Workflow: 'sim-order', Version: 99, Status: 'running', Attempt: 0, CreatedAt: now, UpdatedAt: now });
        return true;
      }),
    status: () => db.execute("UPDATE __workflow SET Status = 'completed' WHERE Status = 'compensated'").then(() => undefined),
  };
  return { name: 'tamper', replica: 'tamper', tick: act[kind], restart: () => Promise.resolve() };
}

async function buildWorkflow(env: SimEnv, o: WorkflowSuiteOptions): Promise<SimSystem> {
  current = { env, drift: o.tamper === 'drift', swap: o.tamper === 'swap', activated: new Set() };
  await env.boot({
    template: 'workflow',
    aliases: ['workflow', 'queue'],
    config: {
      queue: { default: 'black-hole', connections: [{ name: 'black-hole', service: 'BlackHoleQueueClient' }] },
      system: { dirs: { workflows: [] } },
      // shutdownGrace is wall-clock drain time on dispose, kept short as in the scheduler suite
      workflow: { enabled: false, tick: 1000, concurrency: 1, leaseTtl: LEASE_TTL, shutdownGrace: 50, compensateOnCancel: false },
    },
  });
  const db = env.database.driver;
  for (const table of ['sim_wf_effect', 'sim_wf_compensation']) {
    await db.schema().createTable(table, (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('InstanceId', 128).notNull();
      t.string('Step', 32).notNull();
      t.string('Replica', 32).notNull();
    });
  }
  const service = await DI.resolve(WorkflowService);

  const engines = new Map<string, WorkflowEngine>();
  const startEngine = async (replica: string): Promise<void> => {
    engines.set(replica, await DI.resolve(WorkflowEngine, [{ replicaId: currentReplicaId() }]));
  };
  for (const replica of ENGINES) await runInContext(env.replicas.context(replica), () => startEngine(replica));
  const engineOf = (replica: string): WorkflowEngine => {
    const engine = engines.get(replica);
    if (!engine) throw new Error(`workflow suite: engine ${replica} was never started`);
    return engine;
  };

  const steps = async (): Promise<StepRow[]> => await db.select<StepRow[]>().from('__workflow_step');
  const instances = async (): Promise<InstanceRow[]> => await db.select<InstanceRow[]>().from('__workflow');
  const results = new WriteOnceLedger();

  /** Instance id to the `fail` flag of its input. */
  const started = new Map<string, boolean>();
  const sent = new Map<string, number>();
  const signaler: SimActor = {
    name: 'signaler',
    replica: 'signaler',
    tick: async () => {
      if (started.size === 0) return;
      const id = env.random.pick([...started.keys()]);
      // every signal is its own event: a second one stays pending when the wait took the first, and must never be consumed by it
      const sends = o.tamper === 'consume' || env.random.chance(0.3) ? 2 : 1;
      for (let i = 0; i < sends; i++) {
        const n = (sent.get(id) ?? 0) + 1;
        sent.set(id, n);
        await service.signal(id, 'approve', { ok: true }, { principal: 'user:sim', dedupKey: `approve:${id}:${n}` });
      }
    },
    restart: () => Promise.resolve(),
  };
  const actors: SimActor[] = [...ENGINES.map((name) => ({ name, replica: name, tick: () => engineOf(name).tick(), restart: () => startEngine(name) })), signaler];
  if (o.tamper) actors.push(tamperActor(env, o.tamper, steps));

  return {
    actors,
    invariants: [
      invariant('step-results-never-overwritten', async () => {
        const succeeded = (await steps()).filter((s) => s.Status === 'succeeded');
        for (const s of succeeded) results.observe(`${s.InstanceId}|${s.Key}`, s.Result);
        const present = new Set(succeeded.map((s) => `${s.InstanceId}|${s.Key}`));
        const lost = results.keys().filter((k) => !present.has(k));
        ensure(lost.length === 0, 'a succeeded journal row lost its status', lost);
      }),
      invariant('journal-branches-consistent', async () => {
        for (const [id, rows] of byInstance(await steps())) {
          for (const r of rows.filter((row) => row.Kind !== 'compensate')) {
            const call = metaOf(r).call;
            const expected = call === undefined ? undefined : EXPECTED.get(branchOfKey(r.Key))?.[call - 1];
            ensure(expected === r.Key, `${id}: '${r.Key}' is recorded as call ${call} of its branch, which must hold '${expected}'`);
            const result = FAN_OUT_RESULTS.get(r.Key);
            if (result !== undefined && r.Status === 'succeeded') ensure(r.Result === JSON.stringify(result), `${id}: '${r.Key}' holds ${r.Result}, its branch's result is '${result}'`);
          }
        }
      }),
      invariant('no-instance-failed', async () => {
        // every failure of this workload is compensated, so `failed` is a replay or a compensation that went wrong
        const bad = (await instances()).filter((i) => i.Status === 'failed' || i.Status === 'cancelled');
        ensure(
          bad.length === 0,
          'an instance ended failed or cancelled',
          bad.map((i) => `${i.Id}:${i.Status}:${i.Reason}`),
        );
      }),
      invariant('compensations-newest-first', async () => {
        const status = new Map((await instances()).map((i) => [i.Id, i.Status]));
        for (const [id, rows] of byInstance(await steps())) {
          const done = rows.filter((r) => r.Kind === 'step' && r.Status === 'succeeded' && COMPENSABLE.has(r.Key));
          const expected = [...done].sort((a, b) => (metaOf(b).order ?? 0) - (metaOf(a).order ?? 0)).map((r) => `compensate:${r.Key.slice(r.Key.indexOf(':') + 1)}`);
          const compensations = rows.filter((r) => r.Kind === 'compensate').sort((a, b) => a.Seq - b.Seq);
          const actual = compensations.map((r) => r.Key);
          ensure(compensations.every((r, i) => r.Seq === COMPENSATION_SEQ_BASE + i), `the compensation rows of ${id} are not numbered in pass order`, actual);
          ensure(actual.every((k, i) => k === expected[i]), `the compensations of ${id} did not run newest first`, { expected, actual });
          if (status.get(id) === 'compensated') ensure(actual.length === expected.length && compensations.every((r) => r.Status === 'succeeded'), `${id} is compensated but not every compensation succeeded`, { expected, actual });
        }
      }),
      invariant('compensation-effects-at-least-once', async () => {
        const effects = countBy(await db.select<EffectRow[]>().from('sim_wf_compensation'), (e) => `${e.InstanceId}|${e.Step}`);
        const done = (await steps()).filter((s) => s.Kind === 'compensate' && s.Status === 'succeeded');
        const missing = done.map((s) => `${s.InstanceId}|${s.Key.slice(s.Key.indexOf(':') + 1, s.Key.indexOf('#'))}`).filter((k) => (effects.get(k) ?? 0) < 1);
        ensure(missing.length === 0, 'a succeeded compensation left no effect', missing);
      }),
      invariant('transactional-effects-match-journal', async () => {
        const effects = countBy(await db.select<EffectRow[]>().from('sim_wf_effect'), (e) => `${e.InstanceId}|${e.Step}`);
        const journaled = new Set((await steps()).filter((s) => s.Kind === 'step' && s.Status === 'succeeded' && TRANSACTIONAL.has(s.Key)).map((s) => `${s.InstanceId}|${s.Key.slice(5, s.Key.indexOf('#'))}`));
        const keys = new Set([...journaled, ...[...effects.keys()].filter((k) => k.endsWith('|charge') || k.endsWith('|ship'))]);
        for (const key of keys) {
          const rows = effects.get(key) ?? 0;
          const expected = journaled.has(key) ? 1 : 0;
          ensure(rows === expected, `${key} has ${rows} effect rows for ${expected} succeeded journal rows`);
        }
      }),
      invariant('signal-consumed-once-per-wait', async () => {
        const consumed = (await db.select<EventRow[]>().from('__workflow_event')).filter((e) => e.State === 'consumed');
        const twice = overLimit(consumed, waitOf);
        ensure(twice.length === 0, 'one wait consumed two signals', twice);
        // the consume and the wait's journal row commit together: a consumed signal without that row was taken outside the fence
        const journaled = new Set((await steps()).filter((s) => s.Kind === 'wait' && s.Status === 'succeeded' && s.Result !== null).map((s) => `${s.InstanceId}|${s.Key}`));
        const orphans = consumed.map(waitOf).filter((k) => !journaled.has(k));
        ensure(orphans.length === 0, 'a signal is consumed by a wait that journaled no event', orphans);
      }),
      invariant(
        'every-instance-terminal',
        async () => {
          const open = (await instances()).filter((i) => !TERMINAL.includes(i.Status));
          ensure(
            open.length === 0,
            'instances still open after quiescence',
            open.map((i) => `${i.Id}:${i.Status}`),
          );
        },
        { final: true },
      ),
      invariant(
        'outcome-matches-input',
        async () => {
          const approved = new Set((await steps()).filter((s) => s.Kind === 'wait' && s.Status === 'succeeded' && s.Result !== null).map((s) => s.InstanceId));
          for (const i of await instances()) {
            const fail = started.get(i.Id);
            if (fail === undefined) continue;
            // approved and not told to fail: shipped; told to fail, or the wait timed out: charged, then undone
            const expected = !fail && approved.has(i.Id) ? 'completed' : 'compensated';
            ensure(i.Status === expected, `${i.Id} ended ${i.Status}, its input and its approval say ${expected}`, { fail, approved: approved.has(i.Id), reason: i.Reason });
            if (expected === 'completed') ensure(i.Result === JSON.stringify('shipped'), `${i.Id} completed with another result than 'shipped'`, i.Result);
          }
        },
        { final: true },
      ),
    ],
    workload: async (random, step) => {
      if (step % 20 !== 0 || started.size >= MAX_INSTANCES) return;
      const id = `wf-${env.seed}-${started.size + 1}`;
      const fail = random.chance(o.failRate ?? 0.3);
      await service.start('sim-order', { fail }, { id });
      started.set(id, fail);
    },
    quiesced: async () => (await instances()).every((i) => TERMINAL.includes(i.Status)),
    dispose: () => {
      current = undefined;
      return Promise.resolve();
    },
  };
}
