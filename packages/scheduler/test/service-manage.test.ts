import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import {
  appendJournalRow,
  defineSchedule,
  ErrorGroupModel,
  ErrorGroupNotFound,
  FakeClock,
  InvalidRunParams,
  RetentionService,
  RunLogModel,
  RunModel,
  RunStepModel,
  Scheduler,
  SchedulePaused,
  SchedulerService,
  SchedulerSignals,
  ScheduledTask,
  ScheduleModel,
  ScheduleNotFound,
  TriggeredBy,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { queuedRun } from './support/fixtures.js';

chai.use(chaiAsPromised);
const by: TriggeredBy = { kind: 'user', id: '1' };
const DAY = 86_400_000;
class SvcManageQuick extends ScheduledTask {
  public execute(): Promise<number> {
    return Promise.resolve(1);
  }
}

describe('SchedulerService: pause, resume, errors, prune', () => {
  let clock: FakeClock;
  let s: Scheduler;
  let service: SchedulerService;

  beforeEach(async () => {
    defineSchedule(SvcManageQuick, 'minutely', { every: '1m' });
    ({ clock } = await bootTestEnv({
      now: '2026-01-05T10:00:30Z',
      scheduler: { retention: { enabled: false, runs: '30d', logs: '7d', errors: '90d' } },
    }));
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    service = await DI.resolve(SchedulerService);
  });
  afterEach(() => {
    sinon.restore();
    undefineSchedule('minutely');
  });

  it('soft pause stops scheduled runs but not manual ones; hard pause stops both', async () => {
    const info = await service.pause('minutely', { triggeredBy: by });
    expect(info).to.include({ paused: true, pausedReason: 'manual', hardPaused: false });
    clock.set('2026-01-05T10:01:00Z');
    await s.tickOnce();
    expect(await RunModel.where('Schedule', 'minutely')).to.have.length(0);
    await service.runNow('minutely', { triggeredBy: by });
    expect(await service.pause('minutely', { hard: true, triggeredBy: by })).to.include({ hardPaused: true });
    await expect(service.runNow('minutely', { force: true, triggeredBy: by })).to.be.rejectedWith(SchedulePaused);
    await expect(service.pause('ghost', { triggeredBy: by })).to.be.rejectedWith(ScheduleNotFound);
  });

  it('resume clears pause and failure count and re-anchors the next run', async () => {
    const health = sinon.spy(DI.resolve(SchedulerSignals), 'healthChanged');
    await ScheduleModel.update({
      Paused: true,
      PausedReason: 'failures',
      HardPaused: true,
      ConsecutiveFailures: 5,
    }).where('Name', 'minutely');
    clock.set('2026-01-05T12:34:10Z');
    const info = await service.resume('minutely', { triggeredBy: by });
    expect(info).to.include({
      paused: false,
      pausedReason: null,
      hardPaused: false,
      consecutiveFailures: 0,
      health: 'ok',
      nextRunAt: '2026-01-05T12:35:00.000Z',
    });
    expect(health.calledOnceWithExactly('minutely', 0)).to.eq(true);
    // the long pause fires nothing late
    await s.tickOnce();
    expect(await RunModel.where('Schedule', 'minutely')).to.have.length(0);
  });

  it('resume keeps a next run that is still ahead, and resets the count of a schedule that is not paused', async () => {
    await service.pause('minutely', { triggeredBy: by });
    expect(await service.resume('minutely', { triggeredBy: by })).to.include({ nextRunAt: '2026-01-05T10:01:00.000Z' });
    await ScheduleModel.update({ ConsecutiveFailures: 2 }).where('Name', 'minutely');
    expect(await service.resume('minutely', { triggeredBy: by })).to.include({
      consecutiveFailures: 0,
      nextRunAt: '2026-01-05T10:01:00.000Z',
    });
    await expect(service.resume('ghost', { triggeredBy: by })).to.be.rejectedWith(ScheduleNotFound);
  });

  it('lists and updates error groups', async () => {
    const T = clock.now();
    await ErrorGroupModel.create({
      Schedule: 'minutely',
      Fingerprint: 'fp1',
      Name: 'Error',
      SampleMessage: 'x',
      Count: 2,
      FirstSeen: T,
      LastSeen: T,
      Status: 'open',
    });
    expect((await service.listErrors({ schedule: 'minutely', status: 'open' })).map((e) => e.fingerprint)).to.deep.eq([
      'fp1',
    ]);
    expect(await service.setErrorStatus('fp1', 'resolved', { triggeredBy: by })).to.include({
      status: 'resolved',
      count: 2,
    });
    expect(await service.listErrors({ status: 'open' })).to.have.length(0);
    expect(await service.listErrors({ status: ['open', 'resolved'] })).to.have.length(1);
    await expect(service.setErrorStatus('nope', 'resolved', { triggeredBy: by })).to.be.rejectedWith(
      ErrorGroupNotFound,
    );
    await expect(service.setErrorStatus('fp1', 'gone' as never, { triggeredBy: by })).to.be.rejectedWith(
      InvalidRunParams,
    );
  });

  it('prunes orphans, old runs with their children, old logs and old resolved errors', async () => {
    const now = clock.now();
    await ScheduleModel.create({
      Name: 'gone',
      Definition: {},
      DefinitionHash: 'h',
      NextRunAt: null,
      Paused: false,
      HardPaused: false,
      ConsecutiveFailures: 0,
      Orphaned: true,
      UpdatedAt: now,
    });
    const oldRun = await queuedRun('minutely', now - 40 * DAY, { Status: 'succeeded', FinishedAt: now - 40 * DAY });
    const keep = await queuedRun('minutely', now - DAY, { Status: 'succeeded', FinishedAt: now - DAY });
    const oldRunning = await queuedRun('minutely', now - 40 * DAY, { Status: 'running', StartedAt: now - 40 * DAY });
    await RunStepModel.create({
      RunId: oldRun.Id,
      Attempt: 1,
      Seq: 1,
      Name: 's',
      Status: 'succeeded',
      Weight: 1,
      StartedAt: now - 40 * DAY,
      Progress: 100,
    });
    await appendJournalRow({
      RunId: oldRun.Id,
      Schedule: 'minutely',
      Seq: 1,
      Attempt: 1,
      Ts: now - 40 * DAY,
      Kind: 'status',
      Data: { type: 'status' } as never,
    });
    await appendJournalRow({
      RunId: keep.Id,
      Schedule: 'minutely',
      Seq: 1,
      Attempt: 1,
      Ts: now - 10 * DAY,
      Kind: 'status',
      Data: { type: 'status' } as never,
    });
    await appendJournalRow({
      RunId: keep.Id,
      Schedule: 'minutely',
      Seq: 2,
      Attempt: 1,
      Ts: now - 10 * DAY,
      Kind: 'log',
      Data: { type: 'log' } as never,
    });
    await ErrorGroupModel.create({
      Schedule: 'minutely',
      Fingerprint: 'old',
      Name: 'E',
      SampleMessage: 'm',
      Count: 1,
      FirstSeen: now - 100 * DAY,
      LastSeen: now - 100 * DAY,
      Status: 'resolved',
    });
    await ErrorGroupModel.create({
      Schedule: 'minutely',
      Fingerprint: 'open',
      Name: 'E',
      SampleMessage: 'm',
      Count: 1,
      FirstSeen: now - 100 * DAY,
      LastSeen: now - 100 * DAY,
      Status: 'open',
    });

    const result = await service.prune({ triggeredBy: by });
    expect(result).to.deep.eq({ orphanedSchedules: 1, runs: 1, logs: 1, errors: 1 });
    expect((await RunModel.all()).map((r) => r.Id).sort()).to.deep.eq([keep.Id, oldRunning.Id].sort());
    expect(await RunStepModel.all()).to.have.length(0);
    // a kept run keeps its status rows, so a subscription to it still ends
    expect((await RunLogModel.all()).map((r) => [r.RunId, r.Kind])).to.deep.eq([[keep.Id, 'status']]);
    expect((await ErrorGroupModel.all()).map((g) => g.Fingerprint)).to.deep.eq(['open']);
    expect(await ScheduleModel.where('Name', 'gone')).to.have.length(0);
  });

  it('purges in batches until nothing old is left', async () => {
    const now = clock.now();
    for (let i = 0; i < 5; i++)
      await queuedRun('minutely', now - 40 * DAY, { Status: 'failed', FinishedAt: now - 40 * DAY });
    const retention = DI.resolve(RetentionService);
    (retention as unknown as { batchSize: number }).batchSize = 2;
    expect(await retention.purge(now)).to.deep.eq({ runs: 5, logs: 0, errors: 0 });
    expect(await RunModel.all()).to.have.length(0);
  });
});
