import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import {
  currentRunContext,
  defaultReplicaId,
  defineSchedule,
  FakeClock,
  registerTaskMethod,
  RunAbortedError,
  RunAttemptModel,
  RunConflict,
  RunModel,
  RunStepModel,
  ScheduledTask,
  ScheduleModel,
  ScheduleNotFound,
  ScheduleOverlap,
  SchedulerService,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { deferred, driveUntil, journal, queuedRun, untilAborted } from './support/fixtures.js';

chai.use(chaiAsPromised);

class InlineBody extends ScheduledTask {}
class LateBody extends ScheduledTask {}
class StackingTaskAdapter extends ScheduledTask {}
const unregisterAdapter = registerTaskMethod('inline-stacking', StackingTaskAdapter, { stacking: true });

const NAMES = ['inline-skip', 'inline-queue', 'inline-retry', 'inline-stacking', 'inline-all', 'inline-late'];
const crash = () => Object.assign(new Error('process died'), { crash: true });
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('SchedulerService.runInline', () => {
  let service: SchedulerService;
  let clock: FakeClock;

  beforeEach(async () => {
    defineSchedule(InlineBody, 'inline-skip', { manual: true });
    defineSchedule(InlineBody, 'inline-queue', { manual: true, overlap: 'queue' });
    defineSchedule(InlineBody, 'inline-retry', { manual: true, retry: { attempts: 3 } });
    // overlap 'skip' here: stacking comes from the @Task registration, not from the definition
    defineSchedule(StackingTaskAdapter, 'inline-stacking', { manual: true });
    defineSchedule(InlineBody, 'inline-all', { manual: true, runOn: 'all', overlap: 'skip' });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
    service = await DI.resolve(SchedulerService);
  });
  afterEach(() => {
    sinon.restore();
    NAMES.forEach(undefineSchedule);
  });
  after(() => unregisterAdapter());

  const runsOf = (schedule: string) => RunModel.where('Schedule', schedule);
  const onlyRun = async (schedule: string) => {
    const runs = await runsOf(schedule);
    expect(runs).to.have.length(1);
    return runs[0];
  };
  const scheduleRow = (name: string) => ScheduleModel.where('Name', name).first();
  const untilRuns = async (schedule: string, n: number) => {
    while ((await runsOf(schedule)).length < n) await settle();
  };

  it('returns the value and records a succeeded manual run', async () => {
    const value = await service.runInline('inline-skip', (ctx) => Promise.resolve({ runId: ctx.runId, n: 3 }), {
      triggeredBy: 'cleanup-cron',
    });

    const run = await onlyRun('inline-skip');
    expect(value).to.deep.eq({ runId: run.Id, n: 3 });
    expect(run).to.include({ Status: 'succeeded', Trigger: 'manual', Attempt: 1, LeaseOwner: null });
    expect(run.TriggeredBy).to.deep.eq({ kind: 'service', id: 'cleanup-cron' });
    expect(run.Result).to.deep.eq({ runId: run.Id, n: 3 });
    expect((await journal(run.Id)).map((e) => e.type === 'status' && e.status)).to.deep.eq(['running', 'succeeded']);
    expect(await RunAttemptModel.where('RunId', run.Id)).to.have.length(1);
  });

  it('runs the body inside the run context', async () => {
    let seen: string | undefined;
    await service.runInline('inline-skip', () => Promise.resolve((seen = currentRunContext()?.schedule)));
    expect(seen).to.eq('inline-skip');
  });

  it('marks the run failed and rethrows the original error', async () => {
    const boom = new Error('boom');
    await expect(service.runInline('inline-skip', () => Promise.reject(boom))).to.be.rejectedWith(boom);

    const run = await onlyRun('inline-skip');
    expect(run.Status).to.eq('failed');
    expect(run.Error).to.include({ message: 'boom' });
  });

  it('never retries an inline run automatically', async () => {
    await expect(service.runInline('inline-retry', () => Promise.reject(new Error('once')))).to.be.rejectedWith('once');
    expect(await onlyRun('inline-retry')).to.include({ Status: 'failed', MaxAttempts: 1 });
  });

  for (const schedule of ['inline-skip', 'inline-queue']) {
    it(`throws ScheduleOverlap for a second concurrent call on ${schedule}`, async () => {
      const gate = deferred();
      const first = service.runInline(schedule, () => gate.promise.then(() => 1));
      await untilRuns(schedule, 1);

      const err = (await service.runInline(schedule, () => Promise.resolve(2)).catch((e: unknown) => e)) as ScheduleOverlap;
      expect(err).to.be.instanceOf(ScheduleOverlap);
      expect(err).to.be.instanceOf(RunConflict);
      expect(err).to.include({ schedule, runId: (await onlyRun(schedule)).Id });

      gate.resolve();
      expect(await first).to.eq(1);
      expect(await onlyRun(schedule)).to.include({ Status: 'succeeded' });
      expect((await scheduleRow(schedule)).LeaseOwner).to.eq(null);
    });
  }

  it('throws ScheduleOverlap while another replica holds the schedule lease', async () => {
    await ScheduleModel.update({ LeaseOwner: 'other-replica', LeaseUntil: clock.now() + 60_000 }).where('Name', 'inline-skip');

    const err = (await service.runInline('inline-skip', () => Promise.resolve(1)).catch((e: unknown) => e)) as ScheduleOverlap;
    expect(err).to.be.instanceOf(ScheduleOverlap);
    expect(err.runId).to.eq(null);
    expect(await runsOf('inline-skip')).to.have.length(0);
    expect((await scheduleRow('inline-skip')).LeaseOwner).to.eq('other-replica');
  });

  it('lets concurrent calls of a stacking @Task schedule run side by side without the lease', async () => {
    const gate = deferred();
    const calls = [1, 2, 3].map((n) => service.runInline('inline-stacking', () => gate.promise.then(() => n)));
    await untilRuns('inline-stacking', 3);
    expect((await runsOf('inline-stacking')).map((r) => r.Forced)).to.deep.eq([true, true, true]);

    gate.resolve();
    expect(await Promise.all(calls)).to.deep.eq([1, 2, 3]);
    expect((await runsOf('inline-stacking')).map((r) => r.Status)).to.deep.eq(['succeeded', 'succeeded', 'succeeded']);
  });

  it("runs one of two concurrent calls of a runOn: 'all' schedule on this replica", async () => {
    const gate = deferred();
    const calls = [1, 2].map((n) =>
      service.runInline('inline-all', () => gate.promise.then(() => n)).catch((e: unknown) => e),
    );
    gate.resolve();
    const results = await Promise.all(calls);

    expect(results.filter((r) => r instanceof ScheduleOverlap)).to.have.length(1);
    expect(results.filter((r) => typeof r === 'number')).to.have.length(1);
    expect((await runsOf('inline-all')).map((r) => r.Status)).to.deep.eq(['succeeded']);
  });

  it("refuses a runOn: 'all' call while this replica holds a live run of the schedule", async () => {
    const held = await queuedRun('inline-all', clock.now(), {
      Status: 'running',
      Forced: true,
      LeaseOwner: defaultReplicaId(),
      LeaseUntil: clock.now() + 60_000,
    });

    const err = (await service.runInline('inline-all', () => Promise.resolve(1)).catch((e: unknown) => e)) as ScheduleOverlap;
    expect(err).to.be.instanceOf(ScheduleOverlap);
    expect(err.runId).to.eq(held.Id);
  });

  it('rejects with RunAbortedError when the run is cancelled', async () => {
    const call = service.runInline('inline-skip', (ctx) => untilAborted(ctx.signal));
    await untilRuns('inline-skip', 1);
    await service.cancel((await onlyRun('inline-skip')).Id, { triggeredBy: { kind: 'user', id: '1' } });

    await driveUntil(clock, call.catch(() => undefined));
    const err = (await call.catch((e: unknown) => e)) as RunAbortedError;
    expect(err).to.be.instanceOf(RunAbortedError);
    expect(err.reason).to.eq('cancelled');
    expect(await onlyRun('inline-skip')).to.include({ Status: 'aborted' });
  });

  it("rejects with RunAbortedError('lease-lost') when another replica takes the run", async () => {
    const call = service.runInline('inline-skip', (ctx) => untilAborted(ctx.signal));
    await untilRuns('inline-skip', 1);
    await RunModel.update({ LeaseOwner: 'other-replica' }).where('Schedule', 'inline-skip');

    await driveUntil(clock, call.catch(() => undefined));
    const err = (await call.catch((e: unknown) => e)) as RunAbortedError;
    expect(err).to.be.instanceOf(RunAbortedError);
    expect(err.reason).to.eq('lease-lost');
  });

  it('writes nothing after a crash: the run stays running and the schedule lease is kept', async () => {
    const dead = crash();
    await expect(service.runInline('inline-skip', () => Promise.reject(dead))).to.be.rejectedWith(dead);

    const run = await onlyRun('inline-skip');
    expect(run).to.include({ Status: 'running', FinishedAt: null });
    expect(run.LeaseOwner).to.be.a('string');
    expect((await scheduleRow('inline-skip')).LeaseOwner).to.eq(run.LeaseOwner);
    expect((await journal(run.Id)).map((e) => e.type === 'status' && e.status)).to.deep.eq(['running']);
  });

  it('writes nothing for a crash inside a step: no step-end, the step is not failed', async () => {
    const dead = crash();
    await expect(
      service.runInline('inline-skip', (ctx) => ctx.step('work', () => Promise.reject(dead))),
    ).to.be.rejectedWith(dead);

    const run = await onlyRun('inline-skip');
    expect((await RunStepModel.where('RunId', run.Id)).map((s) => s.Status)).to.deep.eq(['running']);
    expect((await journal(run.Id)).map((e) => e.type)).to.not.include('step-end');
  });

  it('keeps the schedule lease when the executor itself crashes', async () => {
    const dead = crash();
    sinon.stub(RunAttemptModel, 'create').rejects(dead);

    await expect(service.runInline('inline-skip', () => Promise.resolve(1))).to.be.rejectedWith(dead);
    expect((await scheduleRow('inline-skip')).LeaseOwner).to.eq(defaultReplicaId());
  });

  it('rejects with the executor failure itself and releases the schedule lease', async () => {
    sinon.stub(RunAttemptModel, 'create').rejects(new Error('disk full'));

    await expect(service.runInline('inline-skip', () => Promise.resolve(1))).to.be.rejectedWith('disk full');
    expect((await scheduleRow('inline-skip')).LeaseOwner).to.eq(null);
  });

  it('inserts a pruned schedule row again instead of refusing the lease', async () => {
    await ScheduleModel.destroy('inline-skip');

    expect(await service.runInline('inline-skip', () => Promise.resolve('back'))).to.eq('back');
    expect(await ScheduleModel.where('Name', 'inline-skip').first()).to.not.eq(undefined);
  });

  it('adopts a schedule declared after the registry was built', async () => {
    defineSchedule(LateBody, 'inline-late', { manual: true });
    expect(await service.runInline('inline-late', () => Promise.resolve('late'))).to.eq('late');
    expect(await ScheduleModel.where('Name', 'inline-late').first()).to.not.eq(undefined);
  });

  it('rejects an unknown schedule', async () => {
    await expect(service.runInline('no-such', () => Promise.resolve(1))).to.be.rejectedWith(ScheduleNotFound);
  });
});
