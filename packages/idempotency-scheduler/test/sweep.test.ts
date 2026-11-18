import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { IdempotencyService } from '@spinajs/idempotency';
import { Scheduler, ScheduleRegistry, SchedulerService } from '@spinajs/scheduler';
import { IDEMPOTENCY_SWEEP_SCHEDULE, IdempotencySweepTask, sweepExpired } from '../src/index.js';
import { bootSweepEnv, disposeSweepEnv } from './support/env.js';

const SCOPE = { namespace: 'test', principal: 'user:1' };
// the first occurrence of an `every: '5m'` schedule after T0 (10:00:30)
const DUE = '2026-11-16T10:05:00.000Z';

/** Completed keys whose replies expire one second after T0. */
async function expiredKeys(count: number): Promise<IdempotencyService> {
  const service = await DI.resolve(IdempotencyService);
  for (let i = 0; i < count; i++) {
    const key = `k${i}`;
    await service.run(SCOPE, key, async () => key, { ttl: '1s', toReply: (value) => ({ kind: 'test', body: value }), fromReply: () => key });
  }
  return service;
}

const definition = async () => (await DI.resolve(ScheduleRegistry)).get(IDEMPOTENCY_SWEEP_SCHEDULE);

describe('idempotency.sweep', function () {
  this.timeout(30_000);

  afterEach(disposeSweepEnv);

  it('is a builtin schedule of the scheduler: leader only, no overlap, every 5 minutes by default', async () => {
    await bootSweepEnv();
    const def = await definition();
    expect(def).to.include({ source: 'builtin', runOn: 'leader', overlap: 'skip', enabled: true, task: IdempotencySweepTask });
    expect(def.spec).to.deep.include({ kind: 'every', intervalMs: 300_000 });
  });

  it('runs every idempotency.sweepEvery', async () => {
    await bootSweepEnv({ idempotency: { sweepEvery: '1m' } });
    expect((await definition()).spec).to.deep.include({ kind: 'every', intervalMs: 60_000 });
  });

  it('is retimed by a scheduler.schedules entry of its name', async () => {
    await bootSweepEnv({ schedules: [{ name: IDEMPOTENCY_SWEEP_SCHEDULE, every: '1h' }] });
    expect((await definition()).spec).to.deep.include({ kind: 'every', intervalMs: 3_600_000 });
  });

  it('is switched off by a scheduler.schedules entry of its name', async () => {
    const clock = await bootSweepEnv({ schedules: [{ name: IDEMPOTENCY_SWEEP_SCHEDULE, enabled: false }] });
    expect(await definition()).to.include({ enabled: false });
    await expiredKeys(1);
    const scheduler = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    clock.set(DUE);
    await scheduler.tickOnce();
    await scheduler.idle();
    const { items } = await (await DI.resolve(SchedulerService)).listRuns({ schedule: IDEMPOTENCY_SWEEP_SCHEDULE });
    expect(items).to.deep.equal([]);
  });

  it('runs on its interval, and the scheduler shows the run, its result and one log line', async () => {
    const clock = await bootSweepEnv();
    const service = await expiredKeys(5);
    const scheduler = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    clock.set(DUE);
    await scheduler.tickOnce();
    await scheduler.idle();

    const operator = await DI.resolve(SchedulerService);
    const listed = (await operator.listSchedules()).find((s) => s.name === IDEMPOTENCY_SWEEP_SCHEDULE);
    expect(listed?.lastRun).to.include({ status: 'succeeded', trigger: 'schedule' });
    const { items } = await operator.listRuns({ schedule: IDEMPOTENCY_SWEEP_SCHEDULE });
    expect(items.map((run) => run.result)).to.deep.equal([{ swept: 5, batches: 4 }]);
    const { logs } = await operator.getRun(items[0].id);
    expect(logs.flatMap((event) => (event.type === 'log' ? [`${event.level}: ${event.message}`] : []))).to.deep.equal(['info: idempotency sweep: 5 rows deleted in 4 batches']);
    expect(await service.sweep()).to.equal(0);
  });

  it('stops between batches once the run is aborted', async () => {
    const clock = await bootSweepEnv();
    const service = await expiredKeys(3);
    clock.set(DUE);
    expect(await sweepExpired(service, AbortSignal.abort())).to.deep.equal({ swept: 0, batches: 0 });
    expect(await sweepExpired(service, new AbortController().signal)).to.deep.equal({ swept: 3, batches: 3 });
  });
});
