import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Job, QueueJob } from '@spinajs/queue';
import {
  defineSchedule,
  emitJobId,
  emitJobKey,
  FakeClock,
  RunAttemptModel,
  RunModel,
  runJobId,
  runJobKey,
  Scheduler,
  ScheduledTask,
  SchedulerService,
  ScheduleModel,
  TriggeredBy,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { journal } from './support/fixtures.js';
import { InMemoryQueueClient, queueConfig } from './support/queue.js';

@Job()
export class EmitSendDigestJob extends QueueJob {
  public execute() {
    return Promise.resolve('sent');
  }
}
class EmitDailyDigest extends ScheduledTask {}
const at = (iso: string) => Date.parse(iso);
const by: TriggeredBy = { kind: 'user', id: '1' };

describe('emit mode', () => {
  let clock: FakeClock;

  beforeEach(async () => {
    InMemoryQueueClient.reset();
    defineSchedule(EmitDailyDigest, 'daily-digest', { every: '1m', emit: EmitSendDigestJob, retry: { attempts: 3 } });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z', extra: queueConfig() }));
  });
  afterEach(() => undefineSchedule('daily-digest'));

  async function tick(s: Scheduler) {
    await s.tickOnce();
    await s.idle();
  }

  it('derives a deterministic 36-character job id per occurrence', () => {
    const t = at('2026-10-15T08:00:00Z');
    expect(emitJobKey('daily-digest', t)).to.eq('daily-digest:2026-10-15T08:00:00.000Z');
    expect(emitJobId('daily-digest', t)).to.eq(emitJobId('daily-digest', t)).and.have.length(36);
    expect(emitJobId('daily-digest', t)).to.not.eq(emitJobId('daily-digest', t + 60_000));
  });

  it('keys scheduled runs on the occurrence and manual runs and retries on the run id', () => {
    const t = at('2026-10-15T08:00:00Z');
    const run = (Trigger: RunModel['Trigger'], Id: string) => ({
      Id,
      Schedule: 'daily-digest',
      Trigger,
      ScheduledAt: t,
    });
    expect(runJobKey(run('schedule', 'a'))).to.eq('daily-digest:2026-10-15T08:00:00.000Z');
    expect(runJobId(run('catch-up', 'a'))).to.eq(emitJobId('daily-digest', t));
    expect(runJobKey(run('manual', 'a'))).to.eq('daily-digest:run:a');
    expect(runJobId(run('retry', 'a')))
      .to.have.length(36)
      .and.not.eq(runJobId(run('retry', 'b')));
    expect(runJobId(run('retry', 'a'))).to.not.eq(emitJobId('daily-digest', t));
  });

  it('emits exactly one job per occurrence across replicas and records it', async () => {
    const all = await Promise.all(
      ['r1', 'r2', 'r3'].map((replicaId) => DI.resolve(Scheduler, [{ replicaId, autoStart: false }])),
    );
    clock.set('2026-01-05T10:01:00Z');
    await Promise.all(all.map((s) => s.tickOnce()));
    await Promise.all(all.map((s) => s.idle()));
    expect(InMemoryQueueClient.Emitted).to.have.length(1);
    const [job] = InMemoryQueueClient.Emitted as unknown as Array<Record<string, unknown>>;
    expect(job).to.include({
      Name: 'EmitSendDigestJob',
      JobId: emitJobId('daily-digest', at('2026-01-05T10:01:00Z')),
      Schedule: 'daily-digest',
      ScheduledAt: '2026-01-05T10:01:00.000Z',
    });
    expect(job.Params).to.deep.eq({});
    const [run] = await RunModel.where('Schedule', 'daily-digest');
    expect(run).to.include({ Status: 'emitted', JobId: job.JobId, LeaseOwner: null, MaxAttempts: 1 });
    expect(run.Message).to.contain('daily-digest:2026-01-05T10:01:00.000Z');
    expect(job.SchedulerRunId).to.eq(run.Id);
    expect((await ScheduleModel.where('Name', 'daily-digest').first()).LeaseOwner).to.eq(null);
    expect((await RunAttemptModel.where('RunId', run.Id)).map((a) => a.Status)).to.deep.eq(['emitted']);
    expect((await journal(run.Id)).map((e) => (e.type === 'status' ? e.status : e.type))).to.deep.eq([
      'running',
      'emitted',
    ]);
  });

  it('fails the run when the emit fails, without scheduler retries', async () => {
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    InMemoryQueueClient.failNext = true;
    clock.set('2026-01-05T10:01:00Z');
    await tick(s);
    const [run] = await RunModel.where('Schedule', 'daily-digest');
    expect(run).to.include({ Status: 'failed', Attempt: 1, NextAttemptAt: null, JobId: null, LeaseOwner: null });
    expect(run.Error).to.include({ message: 'broker unavailable' });
    expect((await ScheduleModel.where('Name', 'daily-digest').first()).LeaseOwner).to.eq(null);

    clock.set('2026-01-05T10:01:30Z');
    await tick(s);
    expect(await RunModel.where('Schedule', 'daily-digest')).to.have.length(1);
  });

  it('gives manual runs and every retry of one retry-failed call their own job', async () => {
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    const service = await DI.resolve(SchedulerService);
    for (const minute of ['01', '02']) {
      InMemoryQueueClient.failNext = true;
      clock.set(`2026-01-05T10:${minute}:00Z`);
      await tick(s);
    }

    clock.set('2026-01-05T10:02:10Z');
    const { runIds } = await service.retryFailed('daily-digest', '2026-01-05T10:00:00Z', { triggeredBy: by });
    const { runId: manualId } = await service.runNow('daily-digest', { triggeredBy: by, force: true });
    for (let i = 0; i < 3; i++) await tick(s);

    const runs = await Promise.all([...runIds, manualId].map((id) => RunModel.where('Id', id).first()));
    expect(runs.map((r) => [r.Trigger, r.Status])).to.deep.eq([
      ['retry', 'emitted'],
      ['retry', 'emitted'],
      ['manual', 'emitted'],
    ]);
    // retries of one call share ScheduledAt, so a key on it would give both the same job
    expect(runs[0].ScheduledAt).to.eq(runs[1].ScheduledAt);
    expect(runs.map((r) => r.JobId)).to.deep.eq(runs.map((r) => runJobId(r)));
    expect(new Set(runs.map((r) => r.JobId)).size).to.eq(3);
    expect(runs.every((r) => r.Message?.includes(`daily-digest:run:${r.Id}`))).to.eq(true);
    expect(InMemoryQueueClient.Emitted.map((e) => (e as unknown as { JobId: string }).JobId).sort()).to.deep.eq(
      runs.map((r) => r.JobId).sort(),
    );
  });

  it('emits to the shipped black-hole connection when no queue is configured', async () => {
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' }));
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    clock.set('2026-01-05T10:01:00Z');
    await tick(s);
    const [run] = await RunModel.where('Schedule', 'daily-digest');
    expect(run).to.include({ Status: 'emitted', JobId: emitJobId('daily-digest', at('2026-01-05T10:01:00Z')) });
    expect(InMemoryQueueClient.Emitted).to.have.length(0);
  });
});
