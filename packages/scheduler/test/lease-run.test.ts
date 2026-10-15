import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { LeaseStore, RunModel, ScheduleModel } from '../src/index.js';
import { bootTestEnv } from './support/env.js';

const T = Date.parse('2026-01-05T10:00:00Z');

async function run(id: string, extra: Partial<RunModel> = {}): Promise<RunModel> {
  return RunModel.create({ Id: id, Schedule: 'a', Trigger: 'manual', Status: 'queued', Attempt: 1, MaxAttempts: 3, CreatedAt: T, Progress: 0, CancelRequested: false, Forced: false, ...extra });
}
const get = (id: string) => RunModel.where('Id', id).first();

describe('LeaseStore: runs', () => {
  let r1: LeaseStore;
  let r2: LeaseStore;

  beforeEach(async () => {
    await bootTestEnv();
    await ScheduleModel.create({ Name: 'a', Definition: {}, DefinitionHash: 'h', NextRunAt: null, Paused: false, HardPaused: false, ConsecutiveFailures: 0, Orphaned: false, UpdatedAt: T });
    r1 = DI.resolve(LeaseStore, ['r1']);
    r2 = DI.resolve(LeaseStore, ['r2']);
  });

  it('claims a queued run once and takes the schedule lease', async () => {
    const a = await run('q1');
    const b = await get('q1');
    expect(await r1.claimRun(a, T)).to.eq(true);
    expect(a.Status).to.eq('running');
    expect(await r2.claimRun(b, T)).to.eq(false);
    const row = await get('q1');
    expect(row).to.include({ Status: 'running', LeaseOwner: 'r1', Attempt: 1, StartedAt: T });
    expect((await ScheduleModel.where('Name', 'a').first()).LeaseOwner).to.eq('r1');
  });

  it('waits for the schedule lease unless the run is forced', async () => {
    await r1.claimRun(await run('q1'), T);
    expect(await r2.claimRun(await run('q2'), T)).to.eq(false);
    expect((await get('q2')).Status).to.eq('queued');
    expect(await r2.claimRun(await run('q3', { Forced: true }), T)).to.eq(true);
  });

  it('claims a due retrying run as the next attempt', async () => {
    const early = await run('r', { Status: 'retrying', Attempt: 1, NextAttemptAt: T + 1000 });
    expect(await r1.claimRun(early, T)).to.eq(false);
    expect((await ScheduleModel.where('Name', 'a').first()).LeaseOwner).to.eq(null);
    const due = await get('r');
    expect(await r1.claimRun(due, T + 1000)).to.eq(true);
    expect(await get('r')).to.include({ Status: 'running', Attempt: 2, NextAttemptAt: null });
  });

  it('renews only while it owns the run and reports cancel requests', async () => {
    await r1.claimRun(await run('q1'), T);
    expect(await r1.renewRun('q1', 'a', T + 20_000, { Progress: 40, CurrentStep: 'load', Message: 'loading' })).to.deep.eq({ ok: true, cancelRequested: false });
    expect(await get('q1')).to.include({ Progress: 40, CurrentStep: 'load', Message: 'loading', LeaseUntil: T + 20_000 + r1.LeaseTtl, UpdatedAt: T + 20_000 });
    await RunModel.update({ CancelRequested: true }).where('Id', 'q1');
    expect(await r1.renewRun('q1', 'a', T + 30_000)).to.deep.eq({ ok: true, cancelRequested: true });
    expect((await r2.renewRun('q1', null, T + 30_000)).ok).to.eq(false);
  });

  it('loses the run when another replica expires it', async () => {
    await r1.claimRun(await run('q1'), T);
    const stale = await get('q1');
    expect(await r2.expireRun(stale, T + 1000, { status: 'aborted', reason: 'lease-expired', nextAttemptAt: null })).to.eq(false);
    expect(await r2.expireRun(stale, T + r1.LeaseTtl + 1, { status: 'retrying', reason: 'lease-expired', nextAttemptAt: T + 120_000 })).to.eq(true);
    expect(await get('q1')).to.include({ Status: 'retrying', Reason: 'lease-expired', LeaseOwner: null, NextAttemptAt: T + 120_000 });
    expect((await r1.renewRun('q1', null, T + r1.LeaseTtl + 2)).ok).to.eq(false);
    expect(await r1.finishRun('q1', { Status: 'succeeded' })).to.eq(false);
  });

  it('finishes only its own run', async () => {
    await r1.claimRun(await run('q1'), T);
    expect(await r2.finishRun('q1', { Status: 'failed' })).to.eq(false);
    expect(await r1.finishRun('q1', { Status: 'succeeded', LeaseOwner: null, LeaseUntil: null, FinishedAt: T + 5 })).to.eq(true);
    expect(await get('q1')).to.include({ Status: 'succeeded', LeaseOwner: null, FinishedAt: T + 5 });
  });
});
