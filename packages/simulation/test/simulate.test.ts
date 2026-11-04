import 'mocha';
import { expect } from 'chai';
import { ensure, invariant, simulate, type FaultRule, type SimActor, type SimEnv, type SimSystem } from '../src/index.js';

const RULES: FaultRule[] = [
  { point: 'outbox.after-insert', when: { probability: 0.1 }, effect: 'crash' },
  { point: 'outbox.before-mark', when: { probability: 0.1 }, effect: 'delay', delayMs: 3_000 },
];

/** Three replicas that touch both fault points, park at random and keep a heartbeat timer per incarnation. */
function toy(env: SimEnv, log: string[]): SimSystem {
  const ticks = new Map<string, number>();
  const actor = (name: string): SimActor => ({
    name,
    replica: name,
    tick: async () => {
      await env.faults.point('outbox.after-insert');
      log.push(`${name}:${env.clock.now()}`);
      if (env.random.chance(0.2)) await env.park(7_000);
      await env.faults.point('outbox.before-mark');
      ticks.set(name, (ticks.get(name) ?? 0) + 1);
    },
    restart: async () => {
      env.clock.setInterval(() => log.push(`${name}:beat:${env.clock.now()}`), 2_000);
    },
  });
  return {
    actors: ['a', 'b', 'c'].map(actor),
    invariants: [invariant('ticks-counted', async () => ensure([...ticks.values()].every((n) => n > 0), 'a tick counter went missing'))],
    workload: async (random, step) => {
      if (step % 7 === 0) log.push(`w:${random.int(100)}`);
    },
    dispose: () => Promise.resolve(),
  };
}

async function runToy(seed: number) {
  const log: string[] = [];
  const report = await simulate((env) => Promise.resolve(toy(env, log)), { seed, steps: 300, faults: RULES, pausableReplicas: ['a', 'b', 'c'], suite: 'toy' });
  return { report, log };
}

const single = (tick: (env: SimEnv) => Promise<void>, extra: SimSystem['invariants'] = []) => (env: SimEnv): Promise<SimSystem> =>
  Promise.resolve({ actors: [{ name: 'a', replica: 'a', tick: () => tick(env), restart: () => Promise.resolve() }], invariants: extra, workload: () => Promise.resolve(), dispose: () => Promise.resolve() });

describe('simulate', () => {
  it('replays a seed identically: same fault hits, same step trace, same system log', async () => {
    const first = await runToy(11);
    const second = await runToy(11);
    expect(first.report.failure).to.equal(undefined);
    expect(second.report.faults).to.deep.equal(first.report.faults);
    expect(second.report.trace).to.deep.equal(first.report.trace);
    expect(second.log).to.deep.equal(first.log);
    expect(first.report.faults.length).to.be.greaterThan(0);
    const actions = new Set(first.report.trace.map((t) => t.action));
    for (const action of ['tick', 'crash', 'restart', 'park', 'resume', 'pause'] as const) expect(actions.has(action), action).to.equal(true);
  });

  it('diverges for two different seeds', async () => {
    const a = await runToy(11);
    const b = await runToy(12);
    expect(b.report.trace).not.to.deep.equal(a.report.trace);
    expect(b.report.faults).not.to.deep.equal(a.report.faults);
  });

  it('reports a broken invariant with the step and the replay command', async () => {
    let ticks = 0;
    const report = await simulate(
      single(
        async () => void ticks++,
        [invariant('too-many-ticks', async () => ensure(ticks < 25, `ticked ${ticks} times`))],
      ),
      { seed: 3, steps: 100, faults: [], suite: 'toy' },
    );
    expect(report.failure?.invariant).to.equal('too-many-ticks');
    expect(report.failure?.step).to.equal(30);
    expect(report.failure?.replay).to.equal('npm run sim -- --suite toy --seed 3');
    expect((report.failure?.error as Error).message).to.equal('ticked 30 times');
  });

  it('fails the run when a tick throws an ordinary error', async () => {
    const report = await simulate(
      single(() => Promise.reject(new Error('boom'))),
      { seed: 1, steps: 5, faults: [] },
    );
    expect(report.failure?.invariant).to.equal('tick:a');
    expect((report.failure?.error as Error).message).to.equal('boom');
  });

  it('fails a tick that waits on simulated time as stuck', async () => {
    const report = await simulate(
      single((env) => env.clock.sleep(1_000)),
      { seed: 1, steps: 5, faults: [], tickTimeoutMs: 200 },
    );
    expect(report.failure?.invariant).to.equal('stuck:a');
  });

  it('resumes a parked tick only after its delay has passed', async () => {
    const waited: number[] = [];
    const report = await simulate(
      single(async (env) => {
        if (env.quiescing) return;
        const t0 = env.clock.now();
        await env.park(10_000);
        waited.push(env.clock.now() - t0);
      }),
      { seed: 4, steps: 20, faults: [], pauseProbability: 0 },
    );
    expect(report.failure).to.equal(undefined);
    expect(waited.length).to.be.greaterThan(0);
    expect(Math.min(...waited)).to.be.at.least(10_000);
    expect(report.trace.some((t) => t.action === 'park')).to.equal(true);
    expect(report.trace.some((t) => t.action === 'resume')).to.equal(true);
  });

  it('restarts crashed actors in quiescence and checks final invariants there', async () => {
    let ticks = 0;
    const report = await simulate(
      single(
        async (env) => {
          await env.faults.point('outbox.after-insert');
          ticks++;
        },
        [invariant('ticked-after-quiescence', async () => ensure(ticks > 0, 'never ticked'), { final: true })],
      ),
      { seed: 5, steps: 30, faults: [{ point: 'outbox.after-insert', when: 'always', effect: 'crash' }], restartProbability: 1 },
    );
    expect(report.failure).to.equal(undefined);
    expect(ticks).to.be.greaterThan(0);
    expect(report.trace.filter((t) => t.action === 'restart').length).to.be.greaterThan(0);
  });
});
