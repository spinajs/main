import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import {
  defineSchedule,
  FakeClock,
  RunContext,
  RunEvent,
  RunEventWriter,
  RunModel,
  RunNotFound,
  RunStepModel,
  Scheduler,
  SchedulerService,
  ScheduledTask,
  ScheduleModel,
  ScheduleNotFound,
  serializeDefinition,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv, waitFor } from './support/env.js';
import { makeDef, queuedRun } from './support/fixtures.js';

chai.use(chaiAsPromised);

class SvcReadStep extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('one', () => 1);
    ctx.log.info('hello');
  }
}
class SvcReadFail extends ScheduledTask {
  public execute(): Promise<void> {
    return Promise.reject(new Error('nope 1'));
  }
}

describe('SchedulerService: read side', () => {
  let clock: FakeClock;
  let s: Scheduler;
  let service: SchedulerService;
  const execute = async (name: string) => {
    const run = await queuedRun(name, clock.now());
    await s.tickOnce();
    await s.idle();
    await clock.advance(1000);
    return run.Id;
  };

  beforeEach(async () => {
    defineSchedule(SvcReadStep, 'svc-ok', { every: '1m' });
    defineSchedule(SvcReadFail, 'svc-fail', { manual: true });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z', scheduler: { runLogLimit: 2 } }));
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    service = await DI.resolve(SchedulerService);
  });
  afterEach(() => ['svc-ok', 'svc-fail'].forEach(undefineSchedule));

  it('lists schedules with spec, next run, health and last run', async () => {
    await execute('svc-fail');
    const list = await service.listSchedules();
    const fail = list.find((x) => x.name === 'svc-fail')!;
    const ok = list.find((x) => x.name === 'svc-ok')!;
    expect(fail).to.deep.include({
      health: 'failing',
      consecutiveFailures: 1,
      mode: 'inline',
      running: false,
      nextRunAt: null,
    });
    expect(fail.spec).to.deep.eq({ kind: 'manual', expression: 'manual', timezone: 'UTC' });
    expect(fail.lastRun).to.include({ status: 'failed', trigger: 'manual' });
    expect(ok).to.deep.include({
      health: 'ok',
      nextRunAt: '2026-01-05T10:01:00.000Z',
      lastRun: null,
      paused: false,
      enabled: true,
    });
  });

  it('describes an orphaned schedule from its stored definition', async () => {
    const def = makeDef('svc-gone', { every: '5m', runOn: 'all', params: { type: 'object' } }, SvcReadStep);
    await ScheduleModel.create({
      Name: 'svc-gone',
      Definition: serializeDefinition(def),
      DefinitionHash: 'h',
      NextRunAt: null,
      Paused: false,
      HardPaused: false,
      ConsecutiveFailures: 0,
      Orphaned: true,
      UpdatedAt: clock.now(),
    });
    const info = (await service.listSchedules()).find((x) => x.name === 'svc-gone')!;
    expect(info).to.deep.include({
      orphaned: true,
      enabled: false,
      runOn: 'all',
      mode: 'inline',
      paramsSchema: { type: 'object' },
    });
    expect(info.spec).to.deep.eq({ kind: 'every', expression: '5m', timezone: 'UTC' });
  });

  it('shows a schedule with recent runs and open errors', async () => {
    await execute('svc-fail');
    const d = await service.getSchedule('svc-fail');
    expect(d.recentRuns).to.have.length(1);
    expect(d.openErrors).to.have.length(1);
    expect(d.openErrors[0]).to.include({ schedule: 'svc-fail', count: 1, status: 'open', name: 'Error' });
    expect(d.definition).to.include({ task: 'SvcReadFail' });
    await expect(service.getSchedule('nope')).to.be.rejectedWith(ScheduleNotFound);
  });

  it('filters and pages runs newest first', async () => {
    for (let i = 0; i < 3; i++) await execute('svc-ok');
    await execute('svc-fail');
    const ok = await service.listRuns({ schedule: 'svc-ok' });
    expect(ok.total).to.equal(3).and.to.be.a('number');
    const failed = await service.listRuns({ status: 'failed' });
    expect(failed.items.map((r) => r.schedule)).to.deep.eq(['svc-fail']);
    const page = await service.listRuns({ limit: 2 });
    expect(page).to.include({ total: 4, limit: 2, offset: 0 });
    expect(page.items[0].schedule).to.eq('svc-fail');
    expect(Date.parse(page.items[0].createdAt)).to.be.greaterThan(Date.parse(page.items[1].createdAt));
    const second = await service.listRuns({ limit: 2, offset: 2 });
    expect(second.items).to.have.length(2);
    const windowed = await service.listRuns({ from: page.items[1].createdAt, to: page.items[0].createdAt });
    expect(windowed.total).to.eq(2);
  });

  it('returns a run with attempts, steps and log lines', async () => {
    const id = await execute('svc-ok');
    const r = await service.getRun(id);
    expect(r).to.include({ status: 'succeeded', progress: 100, stale: false });
    expect(r.attempts.map((a) => a.status)).to.deep.eq(['succeeded']);
    expect(r.steps.map((x) => [x.name, x.status])).to.deep.eq([['one', 'succeeded']]);
    expect(r.logs.map((e) => e.type === 'log' && e.message)).to.deep.eq(['hello']);
    await expect(service.getRun('missing')).to.be.rejectedWith(RunNotFound);
  });

  it('flags a running run as stale when it stopped updating', async () => {
    const run = await queuedRun('svc-fail', clock.now(), {
      Status: 'running',
      LeaseOwner: 'x',
      LeaseUntil: clock.now() + 600_000,
      UpdatedAt: clock.now() - 120_000,
    });
    expect((await service.getRun(run.Id)).stale).to.eq(true);
    expect((await service.listSchedules()).find((x) => x.name === 'svc-fail')!.running).to.eq(true);
  });

  it('subscribes to a run and replays its journal', async () => {
    const id = await execute('svc-ok');
    const got: RunEvent[] = [];
    const off = await service.subscribe({ runId: id }, (e) => got.push(e));
    await waitFor(() => got.some((e) => e.type === 'status' && e.status === 'succeeded'));
    off();
    expect(got[0]).to.include({ type: 'status', seq: 1 });
    await expect(service.subscribe({ runId: 'missing' }, () => undefined)).to.be.rejectedWith(RunNotFound);
    await expect(service.subscribe({ schedule: 'ghost' }, () => undefined)).to.be.rejectedWith(ScheduleNotFound);
  });

  it('passes synthetic progress through, repeating the last seen seq (R16)', async () => {
    const writer = DI.resolve(RunEventWriter);
    const run = await queuedRun('svc-ok', clock.now(), { Status: 'running', StartedAt: clock.now() });
    await writer.write(run, 1, { type: 'status', status: 'running', reason: null });
    await writer.write(run, 1, { type: 'step-start', step: 'one', stepSeq: 1 });
    for (const p of [10, 20, 70]) {
      await writer.write(run, 1, { type: 'progress', progress: p, step: 'one', stepProgress: p });
    }
    await RunStepModel.create({
      RunId: run.Id,
      Attempt: 1,
      Seq: 1,
      Name: 'one',
      Status: 'running',
      Weight: 1,
      StartedAt: clock.now(),
      Progress: 70,
    });
    await RunModel.update({ Progress: 70 }).where('Id', run.Id);

    const got: RunEvent[] = [];
    const off = await service.subscribe({ runId: run.Id }, (e) => got.push(e), { after: 4 });
    off();
    expect(got.map((e) => [e.type, e.seq, e.type === 'progress' ? [e.stepProgress, e.synthetic] : null])).to.deep.eq([
      ['progress', 4, [70, true]],
    ]);
  });
});
