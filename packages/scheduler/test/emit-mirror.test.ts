import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { Job, JobModel, QueueJob, QueueService } from '@spinajs/queue';
import {
  defineSchedule,
  EmitMirror,
  ErrorGroupModel,
  FakeClock,
  mirrorStatus,
  RunAttemptModel,
  RunModel,
  Scheduler,
  ScheduledTask,
  ScheduleModel,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv, waitFor } from './support/env.js';
import { journal } from './support/fixtures.js';
import { InMemoryQueueClient, queueConfig } from './support/queue.js';

let failures = 0;
@Job()
export class EmitMirrorJob extends QueueJob {
  public execute() {
    if (failures-- > 0) return Promise.reject(new Error('job failed'));
    return Promise.resolve({ sent: 3 });
  }
}
class EmitMirrorTask extends ScheduledTask {}

const statuses = async (runId: string) =>
  (await journal(runId)).flatMap((e) => (e.type === 'status' ? [`${e.status}:${e.reason ?? ''}`] : []));
const jobStatus = async (jobId: string) => (await JobModel.where('JobId', jobId).first())?.Status;

describe('emit mode status mirroring', () => {
  let clock: FakeClock;
  let s: Scheduler;

  async function emitOnce(options: { consume?: boolean } = {}) {
    defineSchedule(EmitMirrorTask, 'mirror', { every: '1m', emit: EmitMirrorJob, pauseAfterFailures: 3 });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z', extra: queueConfig() }));
    if (options.consume !== false) await (await DI.resolve(QueueService)).consume(EmitMirrorJob);
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    clock.set('2026-01-05T10:01:00Z');
    await s.tickOnce();
    await s.idle();
    return (await RunModel.where('Schedule', 'mirror'))[0];
  }

  /** An emitted run whose job row the test writes itself. */
  async function emittedRun(jobId: string, createdAt: number) {
    await RunModel.create({
      Id: jobId,
      Schedule: 'mirror',
      Trigger: 'manual',
      Status: 'emitted',
      Attempt: 1,
      MaxAttempts: 1,
      CreatedAt: createdAt,
      StartedAt: createdAt,
      Progress: 0,
      JobId: jobId,
      CancelRequested: false,
      Forced: false,
    });
  }

  beforeEach(() => {
    InMemoryQueueClient.reset();
    failures = 0;
  });
  afterEach(() => {
    sinon.restore();
    undefineSchedule('mirror');
  });

  it('maps queue statuses', () => {
    expect(
      (['success', 'error', 'dead', 'created', 'executing', 'retrying'] as const).map((x) => mirrorStatus(x)),
    ).to.deep.eq(['succeeded', 'failed', 'dead', null, null, null]);
  });

  it('mirrors a successful job', async () => {
    const run = await emitOnce();
    await waitFor(async () => (await jobStatus(run.JobId!)) === 'success');
    clock.set('2026-01-05T10:01:20Z');
    await s.tickOnce();
    const row = await RunModel.where('Id', run.Id).first();
    expect(row).to.include({
      Status: 'succeeded',
      Reason: 'queue',
      Progress: 100,
      FinishedAt: Date.parse('2026-01-05T10:01:20Z'),
      Error: null,
    });
    expect(row.Result).to.deep.eq({ sent: 3 });
    expect((await RunAttemptModel.where('RunId', run.Id)).map((a) => a.Status)).to.deep.eq(['succeeded']);
    expect(await statuses(run.Id)).to.deep.eq(['running:', 'emitted:', 'succeeded:queue']);
    expect(await ScheduleModel.where('Name', 'mirror').first()).to.include({
      LastStatus: 'succeeded',
      LastRunId: run.Id,
      ConsecutiveFailures: 0,
    });
  });

  it('mirrors a dead job with its error and counts it against the schedule', async () => {
    failures = 1;
    const run = await emitOnce();
    await waitFor(async () => (await jobStatus(run.JobId!)) === 'dead');
    await s.tickOnce();
    const row = await RunModel.where('Id', run.Id).first();
    expect(row).to.include({ Status: 'dead', Reason: 'queue' });
    expect(row.Error).to.include({ name: 'QueueJobFailedError', message: 'job failed', attempt: 1 });
    expect(row.Error?.data).to.deep.eq({ jobId: run.JobId, attempt: 1, maxAttempts: 1 });
    expect((await journal(run.Id)).map((e) => e.type)).to.deep.eq(['status', 'status', 'error', 'status']);
    expect((await ScheduleModel.where('Name', 'mirror').first()).ConsecutiveFailures).to.eq(1);
    const groups = await ErrorGroupModel.where('Schedule', 'mirror');
    expect(groups.map((g) => [g.Name, Number(g.Count), g.LastRunId])).to.deep.eq([['QueueJobFailedError', 1, run.Id]]);
  });

  it('mirrors the legacy error status as failed', async () => {
    const run = await emitOnce();
    await waitFor(async () => (await jobStatus(run.JobId!)) === 'success');
    await JobModel.update({ Status: 'error', LastError: 'legacy failure' }).where('JobId', run.JobId!);
    await s.tickOnce();
    expect(await RunModel.where('Id', run.Id).first()).to.include({ Status: 'failed', Reason: 'queue' });
  });

  it('keeps a retrying job emitted and says so', async () => {
    const run = await emitOnce();
    // let the consumer finish first so its last write cannot overwrite the simulated state
    await waitFor(async () => (await jobStatus(run.JobId!)) === 'success');
    await JobModel.update({ Status: 'retrying', Attempt: 1, MaxAttempts: 3, Progress: 40 }).where('JobId', run.JobId!);
    await s.tickOnce();
    expect(await RunModel.where('Id', run.Id).first()).to.include({
      Status: 'emitted',
      Message: 'queue job retrying (attempt 1/3)',
      Progress: 40,
      FinishedAt: null,
    });
  });

  it('caps the mirrored progress of an unfinished job below 100', async () => {
    const run = await emitOnce({ consume: false });
    await JobModel.create({
      JobId: run.JobId!,
      Name: 'EmitMirrorJob',
      Connection: 'memory',
      Status: 'executing',
      Progress: 100,
      Attempt: 0,
      MaxAttempts: 1,
    });
    await s.tickOnce();
    expect(await RunModel.where('Id', run.Id).first()).to.include({ Status: 'emitted', Progress: 99 });
  });

  it('leaves a run emitted while its job has no row yet', async () => {
    const run = await emitOnce({ consume: false });
    await s.tickOnce();
    expect(await RunModel.where('Id', run.Id).first()).to.include({ Status: 'emitted', Progress: 0 });
  });

  it('finalizes a run once when replicas mirror it at the same time', async () => {
    failures = 1;
    const run = await emitOnce();
    await waitFor(async () => (await jobStatus(run.JobId!)) === 'dead');
    const r2 = await DI.resolve(Scheduler, [{ replicaId: 'r2', autoStart: false }]);
    const mirror = DI.resolve(EmitMirror);
    const [a, b] = await Promise.all([mirror.sync(clock.now()), mirror.sync(clock.now())]);
    await Promise.all([s.tickOnce(), r2.tickOnce()]);
    expect(a + b).to.eq(1);
    expect(await statuses(run.Id)).to.deep.eq(['running:', 'emitted:', 'dead:queue']);
    expect((await ScheduleModel.where('Name', 'mirror').first()).ConsecutiveFailures).to.eq(1);
    expect((await ErrorGroupModel.where('Schedule', 'mirror')).map((g) => Number(g.Count))).to.deep.eq([1]);
  });

  it('does not let runs whose job never shows up hide newer ones', async () => {
    await emitOnce({ consume: false });
    await RunModel.truncate();
    const mirror = DI.resolve(EmitMirror) as EmitMirror & { batchSize: number };
    mirror.batchSize = 2;
    const t = clock.now();
    for (const id of ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']) {
      await emittedRun(id, t);
    }
    const last = '00000000-0000-4000-8000-000000000003';
    await emittedRun(last, t + 1);
    await JobModel.create({
      JobId: last,
      Name: 'EmitMirrorJob',
      Connection: 'memory',
      Status: 'success',
      Progress: 100,
      Attempt: 0,
      MaxAttempts: 1,
    });

    expect(await mirror.sync(t + 10)).to.eq(0);
    expect(await mirror.sync(t + 10)).to.eq(1);
    expect((await RunModel.where('Id', last).first()).Status).to.eq('succeeded');
  });

  it('turns mirroring off with one warning when queue_jobs cannot be read', async () => {
    const run = await emitOnce({ consume: false });
    const mirror = DI.resolve(EmitMirror);
    const warn = sinon.spy((mirror as unknown as { Log: { warn: (...args: unknown[]) => void } }).Log, 'warn');
    sinon.stub(JobModel, 'query').throws(new Error('no queue connection'));
    expect(await mirror.sync(clock.now())).to.eq(0);
    expect(await mirror.sync(clock.now())).to.eq(0);
    expect(warn.callCount).to.eq(1);
    expect(String(warn.firstCall.args[0])).to.contain('no queue connection');
    expect((await RunModel.where('Id', run.Id).first()).Status).to.eq('emitted');
  });
});
