import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import {
  defineSchedule,
  FakeClock,
  InvalidRunParams,
  RunConflict,
  RunContext,
  RunModel,
  Scheduler,
  SchedulePaused,
  SchedulerService,
  ScheduledTask,
  ScheduleModel,
  ScheduleNotFound,
  TriggeredBy,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv, waitFor } from './support/env.js';
import { deferred, driveUntil, getRun, journal, queuedRun } from './support/fixtures.js';

chai.use(chaiAsPromised);

const by: TriggeredBy = { kind: 'user', id: '42', name: 'Ada' };
let gate = deferred();
let localGate = deferred();
let seenParams: unknown;
class SvcRunEcho extends ScheduledTask {
  public async execute(ctx: RunContext) {
    seenParams = ctx.params;
    await gate.promise;
    return ctx.params;
  }
}
/** Scheduled (local) occurrences wait for `localGate`, manual runs for `gate`. */
class SvcRunLocal extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await (ctx.trigger === 'schedule' ? localGate.promise : gate.promise);
  }
}
const SCHEMA = {
  type: 'object',
  properties: { n: { type: 'integer' }, mode: { type: 'string', default: 'full' } },
  required: ['n'],
  additionalProperties: false,
};
const NAMES = ['with-params', 'no-params', 'queueing', 'retried', 'everywhere'];

describe('SchedulerService.runNow', () => {
  let clock: FakeClock;
  let s: Scheduler;
  let service: SchedulerService;

  beforeEach(async () => {
    gate = deferred();
    gate.resolve();
    localGate = deferred();
    localGate.resolve();
    seenParams = undefined;
    defineSchedule(SvcRunEcho, 'with-params', { manual: true, params: SCHEMA });
    defineSchedule(SvcRunEcho, 'no-params', { manual: true });
    defineSchedule(SvcRunEcho, 'queueing', { manual: true, overlap: 'queue' });
    defineSchedule(SvcRunEcho, 'retried', { manual: true, retry: { attempts: 3 } });
    defineSchedule(SvcRunLocal, 'everywhere', { every: '1m', runOn: 'all' });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    service = await DI.resolve(SchedulerService);
  });
  afterEach(() => NAMES.forEach(undefineSchedule));

  it('creates a queued manual run with validated, coerced params', async () => {
    const params = { n: '5' };
    const { runId } = await service.runNow('with-params', { params, triggeredBy: by });
    const run = await getRun(runId);
    expect(run).to.include({
      Status: 'queued',
      Trigger: 'manual',
      ScheduledAt: clock.now(),
      Attempt: 1,
      MaxAttempts: 1,
    });
    expect(run.TriggeredBy).to.deep.eq(by);
    expect(run.Params).to.deep.eq({ n: 5, mode: 'full' });
    expect(params).to.deep.eq({ n: '5' });
    expect((await journal(runId)).map((e) => e.type === 'status' && [e.status, e.reason])).to.deep.eq([
      ['queued', 'manual'],
    ]);
    await s.tickOnce();
    await s.idle();
    expect(seenParams).to.deep.eq({ n: 5, mode: 'full' });
  });

  it('gives a manual run the schedule retry budget', async () => {
    const { runId } = await service.runNow('retried', { triggeredBy: by });
    expect(await getRun(runId)).to.include({ Attempt: 1, MaxAttempts: 3 });
  });

  it('rejects invalid params without creating a run', async () => {
    const err = (await service
      .runNow('with-params', { params: { x: 1 }, triggeredBy: by })
      .catch((e: unknown) => e)) as InvalidRunParams;
    expect(err).to.be.instanceOf(InvalidRunParams);
    expect(err.errors).to.deep.include({ path: '/n', message: 'is required' });
    expect(err.errors).to.deep.include({ path: '/x', message: 'is not allowed' });
    const typed = (await service
      .runNow('with-params', { params: { n: 'abc' }, triggeredBy: by })
      .catch((e: unknown) => e)) as InvalidRunParams;
    expect(typed.errors).to.deep.eq([{ path: '/n', message: 'must be integer' }]);
    await expect(service.runNow('no-params', { params: { a: 1 }, triggeredBy: by })).to.be.rejectedWith(
      InvalidRunParams,
    );
    expect(await RunModel.all()).to.have.length(0);
  });

  it('returns 409-style conflicts unless forced', async () => {
    gate = deferred();
    const first = await service.runNow('no-params', { triggeredBy: by });
    const conflict = await service.runNow('no-params', { triggeredBy: by }).catch((e: unknown) => e);
    expect(conflict).to.be.instanceOf(RunConflict);
    expect((conflict as RunConflict).runId).to.eq(first.runId);
    const forced = await service.runNow('no-params', { force: true, triggeredBy: by });
    expect((await getRun(forced.runId)).Forced).to.eq(true);
    await service.runNow('queueing', { triggeredBy: by });
    await s.tickOnce();
    const running = await RunModel.where('Schedule', 'queueing').first();
    expect(running.Status).to.eq('running');
    const busy = await service.runNow('queueing', { triggeredBy: by }).catch((e: unknown) => e);
    expect((busy as RunConflict).runId).to.eq(running.Id);
    const queued = await service.runNow('queueing', { force: true, triggeredBy: by });
    expect(await getRun(queued.runId)).to.include({ Status: 'queued', Forced: false });
    gate.resolve();
    await s.idle();
  });

  it('refuses manual runs on a hard-paused schedule only', async () => {
    await ScheduleModel.update({ Paused: true, PausedReason: 'manual', HardPaused: true }).where('Name', 'no-params');
    await expect(service.runNow('no-params', { triggeredBy: by })).to.be.rejectedWith(SchedulePaused);
    await ScheduleModel.update({ HardPaused: false }).where('Name', 'no-params');
    expect((await service.runNow('no-params', { triggeredBy: by })).runId).to.be.a('string');
    await expect(service.runNow('ghost', { triggeredBy: by })).to.be.rejectedWith(ScheduleNotFound);
  });

  it('waits for the end of the run', async () => {
    const pending = service.runNow('no-params', { wait: true, triggeredBy: by });
    await waitFor(async () => (await RunModel.all()).length === 1);
    await s.tickOnce();
    await s.idle();
    const result = await pending;
    expect(result.run).to.include({ status: 'succeeded', id: result.runId });
  });

  it('stops waiting after the timeout and reports the current state', async () => {
    const pending = service.runNow('no-params', { wait: { timeoutMs: 5000 }, triggeredBy: by });
    await driveUntil(clock, pending);
    expect((await pending).run).to.include({ status: 'queued' });
    expect(clock.pendingTimers).to.eq(0);
  });

  it('runs a queued run in this process with runLocally', async () => {
    const { runId } = await service.runNow('no-params', { triggeredBy: by });
    expect(await s.runLocally(runId)).to.eq(true);
    await s.idle();
    expect((await getRun(runId)).Status).to.eq('succeeded');
    expect(await s.runLocally(runId)).to.eq(false);
    expect(await s.runLocally('missing')).to.eq(false);
  });

  it('does not run a queued run locally while this process holds the schedule, even after its lease expired', async () => {
    gate = deferred();
    await service.runNow('queueing', { triggeredBy: by });
    await s.tickOnce();
    const { runId } = await service.runNow('queueing', { force: true, triggeredBy: by });
    // a stalled heartbeat: the database would let this replica take its own lease again
    await ScheduleModel.update({ LeaseUntil: clock.now() - 1 }).where('Name', 'queueing');
    expect(await s.runLocally(runId)).to.eq(false);
    expect((await getRun(runId)).Status).to.eq('queued');
    gate.resolve();
    await s.idle();
    expect(await s.runLocally(runId)).to.eq(true);
    await s.idle();
    expect((await getRun(runId)).Status).to.eq('succeeded');
  });

  describe("on a runOn 'all' schedule", () => {
    it('creates one forced run that any replica may execute once', async () => {
      const { runId } = await service.runNow('everywhere', { triggeredBy: by });
      expect(await getRun(runId)).to.include({ Status: 'queued', Forced: true, MaxAttempts: 1 });
      await s.tickOnce();
      await s.idle();
      expect(await getRun(runId)).to.include({ Status: 'succeeded' });
      expect(await RunModel.where('Schedule', 'everywhere').where('Trigger', 'manual')).to.have.length(1);
    });

    it('conflicts only with a queued manual run, not with local runs of other replicas', async () => {
      const first = await service.runNow('everywhere', { triggeredBy: by });
      const conflict = await service.runNow('everywhere', { triggeredBy: by }).catch((e: unknown) => e);
      expect((conflict as RunConflict).runId).to.eq(first.runId);
      expect((await service.runNow('everywhere', { force: true, triggeredBy: by })).runId).to.be.a('string');
    });

    it('is not claimed by a replica that runs the schedule locally; another replica takes it', async () => {
      localGate = deferred();
      gate = deferred();
      const r2 = await DI.resolve(Scheduler, [{ replicaId: 'r2', autoStart: false }]);
      await s.tickOnce();
      clock.set('2026-01-05T10:01:00Z');
      await s.tickOnce();
      const local = await RunModel.where('Schedule', 'everywhere').where('Trigger', 'schedule').first();
      expect(local.Status).to.eq('running');
      expect(s.isRunningLocally(local.Id)).to.eq(true);

      const { runId } = await service.runNow('everywhere', { triggeredBy: by });
      await s.tickOnce();
      expect(await s.runLocally(runId)).to.eq(false);
      expect((await getRun(runId)).Status).to.eq('queued');

      await r2.tickOnce();
      expect((await getRun(runId)).Status).to.eq('running');
      expect(r2.isRunningLocally(runId)).to.eq(true);
      expect(s.isRunningLocally(runId)).to.eq(false);

      gate.resolve();
      localGate.resolve();
      await Promise.all([s.idle(), r2.idle()]);
      expect((await getRun(runId)).Status).to.eq('succeeded');
    });

    it('skips the local occurrence while a manual run of the schedule runs on this replica', async () => {
      gate = deferred();
      await s.tickOnce();
      const { runId } = await service.runNow('everywhere', { triggeredBy: by });
      await s.tickOnce();
      expect(s.isRunningLocally(runId)).to.eq(true);
      clock.set('2026-01-05T10:01:00Z');
      await s.tickOnce();
      const occurrence = await RunModel.where('Schedule', 'everywhere').where('Trigger', 'schedule').first();
      expect(occurrence).to.include({ Status: 'skipped', Reason: 'overlap' });
      gate.resolve();
      await s.idle();
    });

    it('retries failed runs one at a time across replicas', async () => {
      gate = deferred();
      const r2 = await DI.resolve(Scheduler, [{ replicaId: 'r2', autoStart: false }]);
      for (const at of ['2026-01-05T08:00:00Z', '2026-01-05T09:00:00Z']) {
        await queuedRun('everywhere', clock.now(), { Status: 'failed', Forced: true, FinishedAt: Date.parse(at) });
      }
      const { runIds } = await service.retryFailed('everywhere', '2026-01-05T00:00:00Z', { triggeredBy: by });
      expect((await Promise.all(runIds.map(getRun))).map((r) => r.Forced)).to.deep.eq([false, false]);

      await s.tickOnce();
      await r2.tickOnce();
      expect((await Promise.all(runIds.map(getRun))).map((r) => r.Status)).to.deep.eq(['running', 'queued']);
      gate.resolve();
      await s.idle();
      await r2.tickOnce();
      await r2.idle();
      expect((await Promise.all(runIds.map(getRun))).map((r) => r.Status)).to.deep.eq(['succeeded', 'succeeded']);
    });
  });

  describe('a run waiting for its automatic retry', () => {
    it('is in progress: a manual run conflicts with it unless forced', async () => {
      const waiting = await queuedRun('retried', clock.now(), {
        Status: 'retrying',
        MaxAttempts: 3,
        NextAttemptAt: clock.now() + 60_000,
      });
      const conflict = (await service.runNow('retried', { triggeredBy: by }).catch((e: unknown) => e)) as RunConflict;
      expect(conflict).to.be.instanceOf(RunConflict);
      expect(conflict.runId).to.eq(waiting.Id);
      const forced = await service.runNow('retried', { force: true, triggeredBy: by });
      expect(await getRun(forced.runId)).to.include({ Forced: true });

      await queuedRun('queueing', clock.now(), { Status: 'retrying', NextAttemptAt: clock.now() + 60_000 });
      const queued = await service.runNow('queueing', { force: true, triggeredBy: by });
      expect(await getRun(queued.runId)).to.include({ Status: 'queued', Forced: false });
    });
  });

  it('names the field of a bad date filter', async () => {
    for (const field of ['from', 'to'] as const) {
      const err = (await service.listRuns({ [field]: 'soon' }).catch((e: unknown) => e)) as InvalidRunParams;
      expect(err).to.be.instanceOf(InvalidRunParams);
      expect(err.errors).to.deep.eq([{ path: `/${field}`, message: 'expected an ISO-8601 date' }]);
    }
  });
});
