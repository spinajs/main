import { expect } from 'chai';
import { DI } from '@spinajs/di';
import {
  appendJournalRow,
  ErrorGroupModel,
  RunAttemptModel,
  RunLogModel,
  RunModel,
  RunStepModel,
  Scheduler,
  ScheduleRegistry,
  SchedulerRetentionTask,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { queuedRun } from './support/fixtures.js';

const DAY = 86_400_000;
const RETENTION = { enabled: true, schedule: '30 3 * * *', runs: '30d', logs: '7d', errors: '90d' };

async function journalRow(runId: string, seq: number, kind: string, ts: number): Promise<void> {
  await appendJournalRow({
    RunId: runId,
    Schedule: 'scheduler-retention',
    Seq: seq,
    Attempt: 1,
    Ts: ts,
    Kind: kind,
    Data: { type: kind } as never,
  });
}

async function errorGroup(fingerprint: string, status: 'open' | 'resolved', lastSeen: number): Promise<void> {
  await ErrorGroupModel.create({
    Schedule: 'scheduler-retention',
    Fingerprint: fingerprint,
    Name: 'Error',
    SampleMessage: 'm',
    Count: 1,
    FirstSeen: lastSeen,
    LastSeen: lastSeen,
    Status: status,
  });
}

describe('scheduler-retention builtin', () => {
  it('is registered from config as a nightly leader schedule', async () => {
    await bootTestEnv({ now: '2026-01-05T03:29:00Z', scheduler: { retention: RETENTION } });
    const def = (await DI.resolve(ScheduleRegistry)).get('scheduler-retention');
    expect(def).to.include({
      source: 'builtin',
      overlap: 'skip',
      runOn: 'leader',
      enabled: true,
      task: SchedulerRetentionTask,
    });
    expect(def.spec).to.include({ kind: 'cron', expression: '30 3 * * *' });
    expect(def.misfire).to.deep.eq({ kind: 'run-once' });
  });

  it('purges old runs, log rows and resolved errors on its schedule', async () => {
    const { clock } = await bootTestEnv({ now: '2026-01-05T03:29:00Z', scheduler: { retention: RETENTION } });
    const now = Date.parse('2026-01-05T03:30:00Z');
    const old = await queuedRun('scheduler-retention', now - 40 * DAY, {
      Status: 'succeeded',
      FinishedAt: now - 40 * DAY,
    });
    await RunAttemptModel.create({ RunId: old.Id, Attempt: 1, StartedAt: now - 40 * DAY, Status: 'succeeded' });
    await RunStepModel.create({
      RunId: old.Id,
      Attempt: 1,
      Seq: 1,
      Name: 'old-step',
      Status: 'succeeded',
      Weight: 1,
      StartedAt: now - 40 * DAY,
      Progress: 100,
    });
    await journalRow(old.Id, 1, 'status', now - 40 * DAY);
    const kept = await queuedRun('scheduler-retention', now - 10 * DAY, {
      Status: 'failed',
      FinishedAt: now - 10 * DAY,
    });
    await journalRow(kept.Id, 1, 'status', now - 10 * DAY);
    await journalRow(kept.Id, 2, 'log', now - 10 * DAY);
    await journalRow(kept.Id, 3, 'message', now - 10 * DAY);
    await journalRow(kept.Id, 4, 'log', now - 1 * DAY);
    // not terminal: an emitted run whose job is still in flight stays until it ends or is cancelled
    const emitted = await queuedRun('scheduler-retention', now - 40 * DAY, { Status: 'emitted' });
    await errorGroup('old-resolved', 'resolved', now - 100 * DAY);
    await errorGroup('old-open', 'open', now - 100 * DAY);
    await errorGroup('new-resolved', 'resolved', now - 10 * DAY);

    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    clock.set('2026-01-05T03:30:00Z');
    await s.tickOnce();
    await s.idle();

    const runs = await RunModel.where('Schedule', 'scheduler-retention').orderBy('CreatedAt');
    expect(runs.map((r) => r.Id)).to.deep.eq([emitted.Id, kept.Id, runs[2].Id]);
    const run = runs[2];
    expect(run).to.include({ Status: 'succeeded', Trigger: 'schedule' });
    expect(run.Result).to.deep.eq({ runs: 1, logs: 2, errors: 1 });
    expect(await RunAttemptModel.where('RunId', old.Id)).to.have.length(0);
    expect(await RunStepModel.where('RunId', old.Id)).to.have.length(0);
    expect((await RunStepModel.where('RunId', run.Id)).map((st) => st.Name)).to.deep.eq(['purge']);
    expect((await RunLogModel.where('RunId', kept.Id).orderBy('Seq')).map((r) => r.Seq)).to.deep.eq([1, 4]);
    expect((await ErrorGroupModel.all()).map((g) => g.Fingerprint).sort()).to.deep.eq(['new-resolved', 'old-open']);
  });

  it('runs once after downtime', async () => {
    const { clock } = await bootTestEnv({ now: '2026-01-05T03:29:00Z', scheduler: { retention: RETENTION } });
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    clock.set('2026-01-08T12:00:00Z');
    await s.tickOnce();
    await s.idle();
    const runs = await RunModel.where('Schedule', 'scheduler-retention');
    expect(runs.map((r) => r.Status)).to.deep.eq(['succeeded']);
  });

  it('can be disabled', async () => {
    await bootTestEnv({ scheduler: { retention: { enabled: false } } });
    expect((await DI.resolve(ScheduleRegistry)).find('scheduler-retention')).to.eq(undefined);
  });

  it('can be switched off by a config entry like any schedule', async () => {
    const { clock } = await bootTestEnv({
      now: '2026-01-05T03:29:00Z',
      scheduler: { retention: RETENTION, schedules: [{ name: 'scheduler-retention', enabled: false }] },
    });
    expect((await DI.resolve(ScheduleRegistry)).get('scheduler-retention')).to.include({ enabled: false });
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    clock.set('2026-01-05T03:30:00Z');
    await s.tickOnce();
    await s.idle();
    expect(await RunModel.where('Schedule', 'scheduler-retention')).to.have.length(0);
  });
});
