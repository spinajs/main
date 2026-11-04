import 'mocha';
import { expect } from 'chai';
import { bootTestEnv, disposeTestEnv } from './support/env.js';
import { eventsOf, instance, pick, rejects, seedEvent, seedInstance, seedStep, stepsOf } from './support/rows.js';

// Far beyond 2^31 on purpose: every time column must be BIGINT.
const FAR = Date.parse('2200-01-01T00:00:00.000Z');

describe('Workflow_2026_11_10_00_00_00', () => {
  beforeEach(() => bootTestEnv());
  after(disposeTestEnv);

  it('round-trips an instance: BIGINT times, JSON input, flags and the epoch default', async () => {
    await seedInstance('i1', { Input: { order: 7, note: 'x' }, WakeAt: FAR, CreatedAt: FAR, UpdatedAt: FAR, ClaimedUntil: FAR });
    const row = await instance('i1');
    expect(row.Input).to.deep.equal({ order: 7, note: 'x' });
    expect(pick(row, 'WakeAt', 'CreatedAt', 'UpdatedAt', 'ClaimedUntil')).to.deep.equal({ WakeAt: FAR, CreatedAt: FAR, UpdatedAt: FAR, ClaimedUntil: FAR });
    expect(pick(row, 'Status', 'CancelRequested', 'ClaimEpoch', 'Attempt')).to.deep.equal({ Status: 'running', CancelRequested: false, ClaimEpoch: 0, Attempt: 0 });
  });

  it('defaults ClaimEpoch to 0 when the insert leaves it out', async () => {
    await seedInstance('i2', { ClaimEpoch: undefined });
    expect((await instance('i2')).ClaimEpoch).to.equal(0);
  });

  it('keeps one step row per instance and key', async () => {
    await seedStep('i1', 1, 'step:charge#1');
    expect(await rejects(seedStep('i1', 2, 'step:charge#1'))).to.be.instanceOf(Error);
    await seedStep('i1', 2, 'step:charge#2');
    await seedStep('i2', 1, 'step:charge#1');
    expect((await stepsOf('i1')).map((s) => [s.Seq, s.Key])).to.deep.equal([
      [1, 'step:charge#1'],
      [2, 'step:charge#2'],
    ]);
  });

  it('stores step JSON columns and the result flag', async () => {
    await seedStep('i1', 1, 'sleep:nap#1', { Status: 'pending', Meta: { wakeAt: FAR }, Result: 'ok', ResultStored: true });
    const [s] = await stepsOf('i1');
    expect(pick(s, 'Kind', 'Status', 'Meta', 'Result', 'ResultStored')).to.deep.equal({ Kind: 'sleep', Status: 'pending', Meta: { wakeAt: FAR }, Result: 'ok', ResultStored: true });
  });

  it('keeps one event per instance and dedup key, and any number without one', async () => {
    await seedEvent('i1', 'approved', { DedupKey: 'k1', Payload: { ok: true } });
    expect(await rejects(seedEvent('i1', 'approved', { DedupKey: 'k1' }))).to.be.instanceOf(Error);
    await seedEvent('i2', 'approved', { DedupKey: 'k1' });
    await seedEvent('i1', 'approved');
    await seedEvent('i1', 'approved');
    const events = await eventsOf('i1');
    expect(events.map((e) => e.DedupKey ?? null)).to.deep.equal(['k1', null, null]);
    expect(events[0].Payload).to.deep.equal({ ok: true });
  });
});
