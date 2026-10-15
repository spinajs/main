import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import {
  DefaultSchedulerService,
  defineSchedule,
  ErrorGroupModel,
  FakeClock,
  InvalidRunParams,
  InvalidRunState,
  RunContext,
  Scheduler,
  SchedulePaused,
  SchedulerService,
  ScheduledTask,
  ScheduleModel,
  TriggeredBy,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { getRun, journal, queuedRun, untilAborted } from './support/fixtures.js';

chai.use(chaiAsPromised);
const by: TriggeredBy = { kind: 'user', id: '1' };

let failSave = true;
let loads = 0;
let checkpoint: unknown;
let flakyParams: unknown;
class SvcActImport extends ScheduledTask {
  public async execute(ctx: RunContext) {
    checkpoint = ctx.lastCheckpoint;
    const data = await ctx.step('load', async () => {
      loads++;
      await ctx.checkpoint({ page: 9 });
      return 'rows';
    });
    await ctx.step('save', () => {
      if (failSave) throw new Error('save failed');
      return data;
    });
  }
}
class SvcActPatient extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await untilAborted(ctx.signal);
  }
}
class SvcActFlaky extends ScheduledTask {
  public execute(ctx: RunContext): Promise<void> {
    flakyParams = ctx.params;
    return Promise.reject(new Error('flaky'));
  }
}
const NAMES = ['import', 'patient', 'flaky', 'local-flaky'];

/** Runs `beforeNow` once, between cancel() reading the run and writing it. */
class RacyService extends DefaultSchedulerService {
  public beforeNow: (() => Promise<void>) | undefined;
  protected async now(): Promise<number> {
    const hook = this.beforeNow;
    this.beforeNow = undefined;
    if (hook) await hook();
    return super.now();
  }
}

describe('SchedulerService: cancel and retry', () => {
  let clock: FakeClock;
  let s: Scheduler;
  let service: SchedulerService;
  const tick = async () => {
    await s.tickOnce();
    await s.idle();
  };

  beforeEach(async () => {
    failSave = true;
    loads = 0;
    checkpoint = undefined;
    flakyParams = undefined;
    defineSchedule(SvcActImport, 'import', { manual: true, resumable: true });
    defineSchedule(SvcActPatient, 'patient', { manual: true });
    defineSchedule(SvcActFlaky, 'flaky', {
      manual: true,
      retry: { attempts: 2, backoff: 'fixed', delay: '1s' },
      params: { type: 'object', properties: { n: { type: 'integer' } } },
    });
    defineSchedule(SvcActFlaky, 'local-flaky', { every: '1h', runOn: 'all' });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    service = await DI.resolve(SchedulerService);
  });
  afterEach(() => NAMES.forEach(undefineSchedule));

  describe('cancel', () => {
    it('cancels a queued run at once', async () => {
      const { runId } = await service.runNow('patient', { triggeredBy: by });
      const info = await service.cancel(runId, { triggeredBy: by });
      expect(info).to.include({ status: 'aborted', reason: 'cancelled', cancelRequested: true });
      expect(info.finishedAt).to.eq(new Date(clock.now()).toISOString());
      expect((await journal(runId)).map((e) => e.type === 'status' && e.status)).to.deep.eq(['queued', 'aborted']);
      expect((await ScheduleModel.where('Name', 'patient').first()).LastRunId).to.eq(runId);
    });

    it('cancels a retrying run without counting it as a failure', async () => {
      await ScheduleModel.update({ ConsecutiveFailures: 1 }).where('Name', 'flaky');
      const run = await queuedRun('flaky', clock.now(), {
        Status: 'retrying',
        Reason: 'timeout',
        Attempt: 1,
        MaxAttempts: 2,
        NextAttemptAt: clock.now() + 60_000,
      });
      const info = await service.cancel(run.Id, { triggeredBy: by });
      expect(info).to.include({ status: 'aborted', reason: 'cancelled', nextAttemptAt: null });
      expect((await ScheduleModel.where('Name', 'flaky').first()).ConsecutiveFailures).to.eq(1);
      expect(await ErrorGroupModel.all()).to.have.length(0);
    });

    it('cancels a running run held by this process', async () => {
      const { runId } = await service.runNow('patient', { triggeredBy: by });
      await s.tickOnce();
      const info = await service.cancel(runId, { triggeredBy: by });
      expect(info).to.include({ cancelRequested: true });
      await s.idle();
      expect(await getRun(runId)).to.include({ Status: 'aborted', Reason: 'cancelled', CancelRequested: true });
    });

    it('marks a run held by another replica; its holder stops at the next heartbeat', async () => {
      const run = await queuedRun('patient', clock.now(), {
        Status: 'running',
        LeaseOwner: 'elsewhere',
        LeaseUntil: clock.now() + 60_000,
      });
      const info = await service.cancel(run.Id, { triggeredBy: by });
      expect(info).to.include({ status: 'running', cancelRequested: true });
    });

    it('cancels a queued run that the loop claimed meanwhile as a running run', async () => {
      const { runId } = await service.runNow('patient', { triggeredBy: by });
      const racy = await DI.resolve(RacyService);
      racy.beforeNow = () => s.tickOnce();
      const info = await racy.cancel(runId, { triggeredBy: by });
      expect(info).to.include({ status: 'running', cancelRequested: true });
      await s.idle();
      expect(await getRun(runId)).to.include({ Status: 'aborted', Reason: 'cancelled' });
      const statuses = (await journal(runId)).flatMap((e) => (e.type === 'status' ? [e.status] : []));
      expect(statuses).to.deep.eq(['queued', 'running', 'aborted']);
    });

    it('refuses to cancel a finished run', async () => {
      failSave = false;
      const { runId } = await service.runNow('import', { triggeredBy: by });
      await tick();
      await expect(service.cancel(runId, { triggeredBy: by })).to.be.rejectedWith(InvalidRunState);
    });
  });

  describe('retry', () => {
    it('retries a failed run as a linked run that resumes from completed steps', async () => {
      const { runId } = await service.runNow('import', { triggeredBy: by });
      await tick();
      expect((await getRun(runId)).Status).to.eq('failed');
      failSave = false;
      const retry = await service.retry(runId, { triggeredBy: by });
      expect(await getRun(retry.runId)).to.include({
        Trigger: 'retry',
        ParentRunId: runId,
        Attempt: 2,
        MaxAttempts: 2,
        Status: 'queued',
      });
      expect((await getRun(retry.runId)).ResumeFrom).to.deep.eq({ runId });
      await tick();
      expect((await getRun(retry.runId)).Status).to.eq('succeeded');
      expect(loads).to.eq(1);
      expect(checkpoint).to.deep.eq({ page: 9 });
    });

    it('re-runs from the given step and without resume when asked', async () => {
      const { runId } = await service.runNow('import', { triggeredBy: by });
      await tick();
      failSave = false;
      await service.retry(runId, { fromStep: 'load', triggeredBy: by });
      await tick();
      expect(loads).to.eq(2);
      await service.retry(runId, { resume: false, triggeredBy: by });
      await tick();
      expect(loads).to.eq(3);
      expect(checkpoint).to.eq(null);
      await expect(service.retry(runId, { fromStep: 'nope', triggeredBy: by })).to.be.rejectedWith(InvalidRunParams);
    });

    it('gives a retry of an exhausted run the full automatic retry budget', async () => {
      const dead = await queuedRun('flaky', clock.now(), {
        Status: 'dead',
        Attempt: 2,
        MaxAttempts: 2,
        Params: { n: 3 },
      });
      const { runId } = await service.retry(dead.Id, { triggeredBy: by });
      expect(await getRun(runId)).to.include({ Attempt: 3, MaxAttempts: 4 });
      await tick();
      expect(flakyParams).to.deep.eq({ n: 3 });
      expect(await getRun(runId)).to.include({ Status: 'retrying', Attempt: 3 });
      await clock.advance(1000);
      await tick();
      expect(await getRun(runId)).to.include({ Status: 'dead', Attempt: 4 });
    });

    it('validates the params of a retry', async () => {
      const failed = await queuedRun('flaky', clock.now(), { Status: 'failed', Params: { n: 1 } });
      await expect(service.retry(failed.Id, { params: { n: 'x' }, triggeredBy: by })).to.be.rejectedWith(
        InvalidRunParams,
      );
      const { runId } = await service.retry(failed.Id, { params: { n: '7' }, triggeredBy: by });
      expect((await getRun(runId)).Params).to.deep.eq({ n: 7 });
    });

    it("retries a runOn 'all' run as a forced run without automatic retries", async () => {
      const failed = await queuedRun('local-flaky', clock.now(), { Status: 'failed', Forced: true });
      const { runId } = await service.retry(failed.Id, { triggeredBy: by });
      expect(await getRun(runId)).to.include({ Forced: true, Attempt: 2, MaxAttempts: 2 });
    });

    it('only retries failed, dead or aborted runs, and not on a hard-paused schedule', async () => {
      failSave = false;
      const { runId } = await service.runNow('import', { triggeredBy: by });
      await tick();
      await expect(service.retry(runId, { triggeredBy: by })).to.be.rejectedWith(InvalidRunState);
      const failed = await queuedRun('import', clock.now(), { Status: 'failed' });
      await ScheduleModel.update({ Paused: true, PausedReason: 'manual', HardPaused: true }).where('Name', 'import');
      await expect(service.retry(failed.Id, { triggeredBy: by })).to.be.rejectedWith(SchedulePaused);
    });

    it('retries every failed run in a window once, oldest first', async () => {
      const old = await queuedRun('import', clock.now(), {
        Status: 'failed',
        FinishedAt: Date.parse('2026-01-01T00:00:00Z'),
      });
      const a = await queuedRun('import', clock.now(), {
        Status: 'failed',
        FinishedAt: Date.parse('2026-01-05T08:00:00Z'),
      });
      const b = await queuedRun('import', clock.now(), {
        Status: 'dead',
        FinishedAt: Date.parse('2026-01-05T09:00:00Z'),
      });
      const done = await queuedRun('import', clock.now(), {
        Status: 'failed',
        FinishedAt: Date.parse('2026-01-05T09:30:00Z'),
      });
      await queuedRun('import', clock.now(), { Status: 'succeeded', ParentRunId: done.Id, Trigger: 'retry' });
      await queuedRun('import', clock.now(), { Status: 'aborted', FinishedAt: Date.parse('2026-01-05T09:40:00Z') });
      const { runIds } = await service.retryFailed('import', '2026-01-05T00:00:00Z', { triggeredBy: by });
      const retries = await Promise.all(runIds.map(getRun));
      expect(retries.map((r) => r.ParentRunId)).to.deep.eq([a.Id, b.Id]);
      expect(retries.map((r) => r.ParentRunId)).to.not.include(old.Id);
      // claimed in this order
      expect(retries[0].CreatedAt).to.be.lessThan(retries[1].CreatedAt);
      expect(
        (await service.retryFailed('import', new Date('2026-01-05T00:00:00Z'), { triggeredBy: by })).runIds,
      ).to.deep.eq([]);
      await expect(service.retryFailed('import', 'yesterday', { triggeredBy: by })).to.be.rejectedWith(
        InvalidRunParams,
      );
    });
  });
});
