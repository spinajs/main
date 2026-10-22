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
  RunModel,
  Scheduler,
  SchedulePaused,
  SchedulerService,
  ScheduledTask,
  ScheduleModel,
  TriggeredBy,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv, waitFor } from './support/env.js';
import { deferred, driveUntil, getRun, journal, queuedRun, untilAborted } from './support/fixtures.js';

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
let gate = deferred();
class SvcActThrowsLater extends ScheduledTask {
  public async execute(): Promise<void> {
    await gate.promise;
    throw new Error('failed after the cancel');
  }
}
/** Ignores its signal, so an abort leaves the body running past the grace period. */
class SvcActStubborn extends ScheduledTask {
  public async execute(): Promise<void> {
    await gate.promise;
  }
}
const NAMES = ['import', 'patient', 'flaky', 'local-flaky', 'gated', 'stubborn'];

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
    defineSchedule(SvcActStubborn, 'stubborn', { manual: true, timeout: '5s' });
    defineSchedule(SvcActThrowsLater, 'gated', { manual: true, retry: { attempts: 3, backoff: 'fixed', delay: '1s' } });
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
      const bad = (await service
        .retryFailed('import', 'yesterday', { triggeredBy: by })
        .catch((e: unknown) => e)) as InvalidRunParams;
      expect(bad).to.be.instanceOf(InvalidRunParams);
      expect(bad.errors).to.deep.eq([{ path: '/since', message: 'expected an ISO-8601 date' }]);
    });

    it('names the run whose params block a retry-failed batch and creates none', async () => {
      await queuedRun('flaky', clock.now(), { Status: 'failed', Params: { n: 1 }, FinishedAt: clock.now() - 2000 });
      const broken = await queuedRun('flaky', clock.now(), {
        Status: 'failed',
        Params: { n: 'not a number' },
        FinishedAt: clock.now() - 1000,
      });
      const err = (await service
        .retryFailed('flaky', new Date(clock.now() - 60_000), { triggeredBy: by })
        .catch((e: unknown) => e)) as InvalidRunParams;
      expect(err).to.be.instanceOf(InvalidRunParams);
      expect(err.message).to.contain(broken.Id);
      expect(err.errors).to.deep.eq([{ path: '/n', message: 'must be integer' }]);
      expect(await RunModel.where('Trigger', 'retry')).to.have.length(0);
    });
  });

  describe('cancel reaches every later decision', () => {
    const DEAD_HOLDER = { Status: 'running' as const, LeaseOwner: 'gone', Attempt: 1, MaxAttempts: 2 };

    it('a dead holder with a retry policy: the reaper ends the run cancelled, without a retry', async () => {
      await ScheduleModel.update({ ConsecutiveFailures: 1 }).where('Name', 'flaky');
      const run = await queuedRun('flaky', clock.now(), { ...DEAD_HOLDER, LeaseUntil: clock.now() + 60_000 });
      expect(await service.cancel(run.Id, { triggeredBy: by })).to.include({
        status: 'running',
        cancelRequested: true,
      });
      clock.set(clock.now() + 61_000);
      await tick();
      expect(await getRun(run.Id)).to.include({
        Status: 'aborted',
        Reason: 'cancelled',
        NextAttemptAt: null,
        Attempt: 1,
      });
      expect((await journal(run.Id)).map((e) => e.type)).to.deep.eq(['status']);
      expect(await ErrorGroupModel.all()).to.have.length(0);
      expect((await ScheduleModel.where('Name', 'flaky').first()).ConsecutiveFailures).to.eq(1);
    });

    it('a dead holder without a retry policy: the reaper ends the run cancelled, not lease-expired', async () => {
      const run = await queuedRun('import', clock.now(), {
        ...DEAD_HOLDER,
        MaxAttempts: 1,
        LeaseUntil: clock.now() + 60_000,
      });
      await service.cancel(run.Id, { triggeredBy: by });
      clock.set(clock.now() + 61_000);
      await tick();
      expect(await getRun(run.Id)).to.include({ Status: 'aborted', Reason: 'cancelled' });
      expect(await ErrorGroupModel.all()).to.have.length(0);
    });

    it('a holder whose lease already expired: cancel ends the run itself', async () => {
      const run = await queuedRun('flaky', clock.now(), { ...DEAD_HOLDER, LeaseUntil: clock.now() - 1 });
      expect(await service.cancel(run.Id, { triggeredBy: by })).to.include({ status: 'aborted', reason: 'cancelled' });
      expect((await journal(run.Id)).map((e) => e.type === 'status' && [e.status, e.reason])).to.deep.eq([
        ['aborted', 'cancelled'],
      ]);
    });

    it('a task that fails before its heartbeat saw the cancel ends cancelled, not retrying', async () => {
      gate = deferred();
      const { runId } = await service.runNow('gated', { triggeredBy: by });
      await s.tickOnce();
      await waitFor(async () => (await getRun(runId)).Status === 'running');
      // a cancel from another process: only the row is flagged
      await RunModel.update({ CancelRequested: true }).where('Id', runId);
      gate.resolve();
      await s.idle();
      expect(await getRun(runId)).to.include({ Status: 'aborted', Reason: 'cancelled', NextAttemptAt: null });
      expect(await ErrorGroupModel.all()).to.have.length(0);
    });

    it('a cancelled run that became claimable again is ended instead of claimed', async () => {
      const looped = await queuedRun('flaky', clock.now(), {
        Status: 'retrying',
        CancelRequested: true,
        NextAttemptAt: clock.now() + 60_000,
      });
      const local = await queuedRun('flaky', clock.now(), { Status: 'retrying', CancelRequested: true });
      expect(await s.runLocally(local.Id)).to.eq(false);
      expect(await getRun(local.Id)).to.include({ Status: 'aborted', Reason: 'cancelled' });
      await tick();
      expect(await getRun(looped.Id)).to.include({ Status: 'aborted', Reason: 'cancelled', Attempt: 1 });
      expect(s.isRunningLocally(looped.Id)).to.eq(false);
    });

    it('keeps the schedule lease when a cancelled body is still running past its grace period', async () => {
      gate = deferred();
      const { runId } = await service.runNow('stubborn', { triggeredBy: by });
      await s.tickOnce();
      await waitFor(async () => (await getRun(runId)).Status === 'running');
      await RunModel.update({ CancelRequested: true }).where('Id', runId);
      // timeout at 5 s, grace 2 s, the body never settles
      await driveUntil(clock, s.idle());
      expect(await getRun(runId)).to.include({ Status: 'aborted', Reason: 'cancelled' });
      expect((await ScheduleModel.where('Name', 'stubborn').first()).LeaseOwner).to.eq('r1');
      gate.resolve();
    });

    it('leaves a flagged row alone while its local handle is still winding down', async () => {
      gate = deferred();
      const { runId } = await service.runNow('stubborn', { triggeredBy: by });
      await s.tickOnce();
      await waitFor(async () => (await getRun(runId)).Status === 'running');
      // another replica reaped it to retrying meanwhile, and a cancel flagged it
      await RunModel.update({ Status: 'retrying', LeaseOwner: null, LeaseUntil: null, CancelRequested: true }).where(
        'Id',
        runId,
      );
      await s.tickOnce();
      expect(s.isRunningLocally(runId)).to.eq(true);
      expect((await getRun(runId)).Status).to.eq('retrying');
      gate.resolve();
      await s.idle();
      await s.tickOnce();
      expect(await getRun(runId)).to.include({ Status: 'aborted', Reason: 'cancelled' });
    });

    it('claimRun refuses a cancel-flagged row', async () => {
      const run = await queuedRun('flaky', clock.now(), { Status: 'retrying', CancelRequested: true });
      expect(await s.Leases.claimRun(run, clock.now())).to.eq(false);
    });
  });
});
