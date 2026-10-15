import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { LeaseStore, ScheduleModel } from '../src/index.js';
import { bootTestEnv } from './support/env.js';

const T = Date.parse('2026-01-05T10:00:00Z');
const MIN = 60_000;
const row = () => ScheduleModel.where('Name', 'a').first();

describe('LeaseStore: schedule occurrences', () => {
  let r1: LeaseStore;
  let r2: LeaseStore;
  let r3: LeaseStore;

  beforeEach(async () => {
    await bootTestEnv();
    await ScheduleModel.create({ Name: 'a', Definition: {}, DefinitionHash: 'h', NextRunAt: T, Paused: false, HardPaused: false, ConsecutiveFailures: 0, Orphaned: false, UpdatedAt: T });
    r1 = DI.resolve(LeaseStore, ['r1']);
    r2 = DI.resolve(LeaseStore, ['r2']);
    r3 = DI.resolve(LeaseStore, ['r3']);
  });

  it('lets exactly one replica claim an occurrence', async () => {
    const o = { name: 'a', expectedNextRunAt: T, nextRunAt: T + MIN, now: T };
    const results = await Promise.all([r1.tryClaimOccurrence(o), r2.tryClaimOccurrence(o), r3.tryClaimOccurrence(o)]);
    expect(results.filter(Boolean)).to.have.length(1);
    const r = await row();
    expect(r.NextRunAt).to.eq(T + MIN);
    expect(r.LastFiredAt).to.eq(T);
    expect(r.LeaseUntil).to.eq(T + r1.LeaseTtl);
    expect(['r1', 'r2', 'r3']).to.include(r.LeaseOwner);
  });

  it('refuses the next occurrence while the lease is held, but lets one replica advance it', async () => {
    expect(await r1.tryClaimOccurrence({ name: 'a', expectedNextRunAt: T, nextRunAt: T + MIN, now: T })).to.eq(true);
    const next = { name: 'a', expectedNextRunAt: T + MIN, nextRunAt: T + 2 * MIN, now: T + MIN };
    expect(await r2.tryClaimOccurrence({ ...next, now: T + 30_000 })).to.eq(false);
    expect(await r2.advanceOccurrence(next)).to.eq(true);
    expect(await r3.advanceOccurrence(next)).to.eq(false);
    expect((await row()).LeaseOwner).to.eq('r1');
  });

  it('claims after the holder lease expired', async () => {
    await r1.tryClaimOccurrence({ name: 'a', expectedNextRunAt: T, nextRunAt: T + MIN, now: T });
    expect(await r2.tryClaimOccurrence({ name: 'a', expectedNextRunAt: T + MIN, nextRunAt: T + 2 * MIN, now: T + r1.LeaseTtl + 1 })).to.eq(true);
    expect((await row()).LeaseOwner).to.eq('r2');
  });

  it('does not claim an occurrence that was already advanced, even with the lease expired', async () => {
    await r1.tryClaimOccurrence({ name: 'a', expectedNextRunAt: T, nextRunAt: T + MIN, now: T });
    expect(await r2.tryClaimOccurrence({ name: 'a', expectedNextRunAt: T, nextRunAt: T + MIN, now: T + r1.LeaseTtl + 1 })).to.eq(false);
    expect((await row()).LeaseOwner).to.eq('r1');
  });

  it('never claims or advances a paused schedule', async () => {
    await ScheduleModel.update({ Paused: true }).where('Name', 'a');
    const o = { name: 'a', expectedNextRunAt: T, nextRunAt: T + MIN, now: T };
    expect(await r1.tryClaimOccurrence(o)).to.eq(false);
    expect(await r1.advanceOccurrence(o)).to.eq(false);
  });

  it('acquires, renews and releases the schedule lease only for its owner', async () => {
    expect(await r1.acquireScheduleLease('a', T)).to.eq(true);
    expect(await r2.acquireScheduleLease('a', T)).to.eq(false);
    expect(await r1.renewScheduleLease('a', T + 10_000)).to.eq(true);
    expect((await row()).LeaseUntil).to.eq(T + 10_000 + r1.LeaseTtl);
    expect(await r2.renewScheduleLease('a', T + 10_000)).to.eq(false);
    expect(await r2.releaseScheduleLease('a', T)).to.eq(false);
    expect(await r1.releaseScheduleLease('a', T)).to.eq(true);
    expect(await r2.acquireScheduleLease('a', T)).to.eq(true);
  });

  it('records the last run on the schedule', async () => {
    await r1.recordLast('a', T, 'succeeded', 'run-1');
    const r = await row();
    expect(r).to.include({ LastStatus: 'succeeded', LastRunId: 'run-1', LastFinishedAt: T });
  });
});
