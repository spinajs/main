import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import {
  activeSchedulers,
  defineSchedule,
  FakeClock,
  RunContext,
  RunModel,
  Scheduler,
  ScheduledTask,
  ScheduleModel,
  ScheduleValidationError,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv, waitFor } from './support/env.js';
import { deferred, getRun, queuedRun, untilAborted } from './support/fixtures.js';

chai.use(chaiAsPromised);

const at = (iso: string) => Date.parse(iso);

let gate = deferred();
class Quick extends ScheduledTask {
  public async execute() {
    return 'done';
  }
}
class Gated extends ScheduledTask {
  public async execute() {
    await gate.promise;
  }
}
class Patient extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await untilAborted(ctx.signal);
  }
}

const runsOf = (name: string) => RunModel.where('Schedule', name).orderBy('CreatedAt');

describe('Scheduler', () => {
  let clock: FakeClock;
  const scheduler = (replicaId: string) => DI.resolve(Scheduler, [{ replicaId, autoStart: false }]);

  beforeEach(async () => {
    gate = deferred();
    gate.resolve();
    defineSchedule(Quick, 'every-minute', { every: '1m' });
    defineSchedule(Quick, 'once', { at: '2026-01-05T10:03:00Z' });
    defineSchedule(Gated, 'gated', { every: '1m' });
    defineSchedule(Patient, 'patient', { manual: true });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' }));
  });

  afterEach(() => ['every-minute', 'once', 'gated', 'patient'].forEach(undefineSchedule));

  it('resolves one scheduler per replica id, also concurrently', async () => {
    const [a, b, a2] = await Promise.all([scheduler('r1'), scheduler('r2'), scheduler('r1')]);
    expect(a).to.eq(a2);
    expect([a.ReplicaId, b.ReplicaId]).to.deep.eq(['r1', 'r2']);
    expect(await scheduler('r2')).to.eq(b);
    expect(activeSchedulers()).to.include.members([a, b]);
  });

  it('fires a due occurrence exactly once across three replicas', async () => {
    const all = await Promise.all(['r1', 'r2', 'r3'].map(scheduler));
    expect(new Set(all.map((s) => s.ReplicaId)).size).to.eq(3);
    clock.set('2026-01-05T10:01:00Z');
    await Promise.all(all.map((s) => s.tickOnce()));
    await Promise.all(all.map((s) => s.idle()));
    const runs = await runsOf('every-minute');
    expect(runs).to.have.length(1);
    expect(runs[0]).to.include({ Status: 'succeeded', Trigger: 'schedule', ScheduledAt: at('2026-01-05T10:01:00Z') });
    expect((await ScheduleModel.where('Name', 'every-minute').first()).NextRunAt).to.eq(at('2026-01-05T10:02:00Z'));
  });

  it('fires a one-off schedule once', async () => {
    const s = await scheduler('r1');
    clock.set('2026-01-05T10:03:00Z');
    await s.tickOnce();
    await s.idle();
    clock.set('2026-01-05T10:10:00Z');
    await s.tickOnce();
    expect(await runsOf('once')).to.have.length(1);
    expect((await ScheduleModel.where('Name', 'once').first()).NextRunAt).to.eq(null);
  });

  it('runs queued manual runs', async () => {
    const s = await scheduler('r1');
    const run = await queuedRun('every-minute', clock.now());
    await s.tickOnce();
    await s.idle();
    expect((await getRun(run.Id)).Status).to.eq('succeeded');
  });

  it('records a skipped run when the previous one is still running', async () => {
    gate = deferred();
    const s = await scheduler('r1');
    clock.set('2026-01-05T10:01:00Z');
    await s.tickOnce();
    clock.set('2026-01-05T10:02:00Z');
    await s.tickOnce();
    const runs = await runsOf('gated');
    expect(runs.map((r) => r.Status)).to.deep.eq(['running', 'skipped']);
    expect(runs[1]).to.include({ Reason: 'overlap', ScheduledAt: at('2026-01-05T10:02:00Z') });
    expect(runs[1].Message).to.contain(runs[0].Id);
    gate.resolve();
    await s.idle();
  });

  it('does not start a second run of a schedule whose local run holds an expired lease', async () => {
    gate = deferred();
    const s = await scheduler('r1');
    clock.set('2026-01-05T10:01:00Z');
    await s.tickOnce();
    const [first] = await runsOf('gated');
    expect(s.isRunningLocally(first.Id)).to.eq(true);

    // a stalled heartbeat: this replica's own schedule and run leases ran out
    const stale = clock.now() - 1;
    await ScheduleModel.update({ LeaseUntil: stale }).where('Name', 'gated');
    await RunModel.update({ LeaseUntil: stale }).where('Id', first.Id);
    const queued = await queuedRun('gated', clock.now());
    clock.set('2026-01-05T10:02:00Z');
    await s.tickOnce();

    expect((await getRun(queued.Id)).Status).to.eq('queued');
    expect(await getRun(first.Id)).to.include({ Status: 'running', LeaseOwner: 'r1' });
    const runs = await runsOf('gated');
    expect(runs.filter((r) => r.Status === 'running')).to.have.length(1);
    expect(runs.find((r) => r.ScheduledAt === at('2026-01-05T10:02:00Z'))).to.include({ Status: 'skipped' });
    gate.resolve();
    await s.idle();
  });

  it('never claims a run that is already executing locally', async () => {
    const s = await scheduler('r1');
    const run = await queuedRun('patient', clock.now(), { Forced: true });
    await s.tickOnce();
    await waitFor(() => s.isRunningLocally(run.Id));
    // another replica reaped it while the local executor still runs
    await RunModel.update({ Status: 'retrying', LeaseOwner: null, LeaseUntil: null }).where('Id', run.Id);
    await s.tickOnce();
    expect(await getRun(run.Id)).to.include({ Status: 'retrying', Attempt: 1 });
    await s.stop();
  });

  it('reaps a run whose holder died', async () => {
    const s = await scheduler('r1');
    const ghost = await queuedRun('patient', clock.now(), {
      Status: 'running',
      LeaseOwner: 'ghost',
      LeaseUntil: clock.now() - 1,
      StartedAt: clock.now() - 120_000,
    });
    await s.tickOnce();
    expect(await getRun(ghost.Id)).to.include({ Status: 'aborted', Reason: 'lease-expired' });
  });

  it('ticks on its own timer once started', async () => {
    const s = await scheduler('r1');
    s.start();
    clock.set('2026-01-05T10:00:59Z');
    await waitFor(async () => {
      await clock.advance(250);
      return (await runsOf('every-minute')).length === 1;
    });
    await s.stop();
  });

  it('stops claiming and aborts running runs on shutdown', async () => {
    const s = await scheduler('r1');
    const run = await queuedRun('patient', clock.now());
    await s.tickOnce();
    await waitFor(() => s.isRunningLocally(run.Id));
    await s.stop();
    expect(await getRun(run.Id)).to.include({ Status: 'aborted', Reason: 'shutdown' });
    expect((await ScheduleModel.where('Name', 'patient').first()).LeaseOwner).to.eq(null);
    expect(activeSchedulers()).to.not.include(s);
    const later = await queuedRun('every-minute', clock.now());
    await s.tickOnce();
    expect((await getRun(later.Id)).Status).to.eq('queued');
  });

  it('fails the boot on an invalid schedule', async () => {
    defineSchedule(Quick, 'broken', { cron: 'nope' });
    try {
      await bootTestEnv();
      await expect(scheduler('r9')).to.be.rejectedWith(ScheduleValidationError);
    } finally {
      undefineSchedule('broken');
    }
  });
});
