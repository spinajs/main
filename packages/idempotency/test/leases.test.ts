import 'mocha';
import { expect } from 'chai';
import assert from 'node:assert/strict';
import { FaultInjector } from '@spinajs/durable';
import type { FaultPointName, TimerHandle } from '@spinajs/durable';
import { IdempotencyKeyReuse, IdempotencyLeaseLost, IdempotencyLeases, MemoryIdempotencyStore } from '../src/index.js';
import type { IdempotencyAcquisition, IdempotencyHandle } from '../src/index.js';
import { FakeClock } from '@spinajs/durable/testing';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const LEASE = 3_000;
const REPLY = { kind: 'test', body: { n: 1 } };

class RecordingFaults extends FaultInjector {
  public readonly hits: { name: FaultPointName; detail?: Record<string, unknown> }[] = [];

  public point(name: FaultPointName, detail?: Record<string, unknown>): void {
    this.hits.push({ name, detail });
  }
}

class RenewCountingStore extends MemoryIdempotencyStore {
  public renewals = 0;
  public refuse = false;

  public async renew(key: string, token: string, leaseMs: number, now: number): Promise<boolean> {
    this.renewals++;
    return this.refuse ? false : super.renew(key, token, leaseMs, now);
  }
}

// Database time moves on while a renewal is in flight; the renewal timer keeps its own schedule.
class LatencyClock extends FakeClock {
  public extra = 0;

  public now(): number {
    return super.now() + this.extra;
  }

  public setInterval(fn: () => void, ms: number): TimerHandle {
    return super.setInterval(() => {
      this.extra = 0;
      fn();
    }, ms);
  }
}

function setup(renew = true) {
  const clock = new FakeClock(T0);
  const store = new RenewCountingStore();
  const faults = new RecordingFaults();
  const leases = new IdempotencyLeases({ store, timers: clock, now: () => clock.now(), leaseMs: LEASE, faults, renew });
  return { clock, store, faults, leases };
}

function handleOf(acquired: IdempotencyAcquisition): IdempotencyHandle {
  if (acquired.state !== 'claimed') {
    throw new Error(`expected a claim, got ${acquired.state}`);
  }
  return acquired.handle;
}

describe('IdempotencyLeases', () => {
  it('claims a free key, passes the after-claim fault point and replays the completed reply', async () => {
    const { leases, faults } = setup();
    const handle = handleOf(await leases.acquire('k', { fingerprint: 'f1', namespace: 'test' }));

    expect(faults.hits).to.deep.equal([{ name: 'idempotency.after-claim', detail: { key: 'k' } }]);
    expect(await handle.complete(REPLY, 60_000)).to.equal(true);
    expect(await leases.acquire('k', { fingerprint: 'f1' })).to.deep.equal({ state: 'done', reply: REPLY });
  });

  it('answers running with the rest of the lease as the retry hint', async () => {
    const { leases, clock } = setup(false);
    handleOf(await leases.acquire('k'));
    await clock.advance(1_000);

    expect(await leases.acquire('k')).to.deep.equal({ state: 'running', retryAfterMs: 2_000 });
  });

  it('refuses a completed key with another fingerprint, and replays it without one or with the same', async () => {
    const { leases } = setup();
    await handleOf(await leases.acquire('k', { fingerprint: 'f1' })).complete(REPLY, 60_000);

    const refused = await leases.acquire('k', { fingerprint: 'f2' }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(refused).to.be.instanceOf(IdempotencyKeyReuse);
    expect((await leases.acquire('k')).state).to.equal('done');
    expect((await leases.acquire('k', { fingerprint: 'f1' })).state).to.equal('done');
  });

  it('refuses a running key with another fingerprint as key reuse, not as running', async () => {
    const { leases } = setup(false);
    handleOf(await leases.acquire('k', { fingerprint: 'f1' }));

    await assert.rejects(leases.acquire('k', { fingerprint: 'f2' }), IdempotencyKeyReuse);
    expect((await leases.acquire('k', { fingerprint: 'f1' })).state).to.equal('running');
    expect((await leases.acquire('k')).state).to.equal('running');
    expect((await leases.acquire('k', { fingerprint: '' })).state).to.equal('running');
  });

  it('renews every third of the lease, so a holder past several leases keeps its key', async () => {
    const { leases, clock, store } = setup();
    const handle = handleOf(await leases.acquire('k'));
    await clock.advance(10 * LEASE);

    expect(store.renewals).to.be.at.least(29);
    expect((await leases.acquire('k')).state).to.equal('running');
    expect(handle.signal.aborted).to.equal(false);
    await handle.release();
  });

  it('keeps a third-of-the-lease cadence when renewals take time, and survives one failed renewal', async () => {
    const clock = new LatencyClock(T0);
    const at: number[] = [];
    const errors: unknown[] = [];
    class SlowStore extends MemoryIdempotencyStore {
      public async renew(key: string, token: string, leaseMs: number, now: number): Promise<boolean> {
        at.push(now);
        clock.extra = 5;
        if (at.length === 2) {
          throw new Error('database blip');
        }
        return super.renew(key, token, leaseMs, now);
      }
    }
    const leases = new IdempotencyLeases({ store: new SlowStore(), timers: clock, now: () => clock.now(), leaseMs: LEASE, onRenewError: (error) => errors.push(error) });
    const handle = handleOf(await leases.acquire('k'));
    await clock.advance(10 * LEASE);

    expect(handle.signal.aborted).to.equal(false);
    expect(errors).to.have.length(1);
    const gaps = at.slice(1).map((t, i) => t - at.slice(i)[0]);
    expect(Math.max(...gaps)).to.be.at.most(LEASE / 3 + LEASE / 12);
    expect(at.length).to.be.at.least(23);
    await handle.release();
  });

  it('stops renewing after a crash: true renewal error, and keeps both the claim and the signal', async () => {
    const clock = new FakeClock(T0);
    let renewals = 0;
    class CrashingStore extends MemoryIdempotencyStore {
      public async renew(): Promise<boolean> {
        renewals++;
        throw Object.assign(new Error('simulated crash'), { crash: true });
      }
    }
    const leases = new IdempotencyLeases({ store: new CrashingStore(), timers: clock, now: () => clock.now(), leaseMs: LEASE });
    const handle = handleOf(await leases.acquire('k'));
    await clock.advance(LEASE);

    expect(renewals).to.equal(1);
    expect(clock.pendingTimers).to.equal(0);
    expect(handle.signal.aborted).to.equal(false);
    await handle.release();
    expect((await leases.peek('k'))?.state).to.equal('running');
  });

  it('aborts the handle signal with IdempotencyLeaseLost when a renewal is refused', async () => {
    const { leases, clock, store } = setup();
    const handle = handleOf(await leases.acquire('k'));
    store.refuse = true;
    await clock.advance(1_000);

    expect(handle.signal.aborted).to.equal(true);
    expect(handle.signal.reason).to.be.instanceOf(IdempotencyLeaseLost);
    expect(clock.pendingTimers).to.equal(0);
  });

  it('keeps an abandoned claim until its lease ends; then another caller takes it over and the old holder is fenced out', async () => {
    const { leases, clock } = setup();
    const old = handleOf(await leases.acquire('k'));
    await old.abandon();
    expect(clock.pendingTimers).to.equal(0);

    await clock.advance(LEASE);
    expect((await leases.acquire('k')).state).to.equal('running');

    await clock.advance(1);
    const fresh = handleOf(await leases.acquire('k'));
    expect(await old.complete(REPLY, 60_000)).to.equal(false);
    expect(await fresh.complete(REPLY, 60_000)).to.equal(true);
  });

  it('stops renewing once a claim completes or is released', async () => {
    const { leases, clock } = setup();
    await handleOf(await leases.acquire('a')).complete(REPLY, 60_000);
    await handleOf(await leases.acquire('b')).release();

    expect(clock.pendingTimers).to.equal(0);
    expect(await leases.peek('b')).to.equal(undefined);
    expect((await leases.peek('a'))?.state).to.equal('done');
  });

  it('sets no timer for a store whose claims never expire', async () => {
    const { leases, clock } = setup(false);
    handleOf(await leases.acquire('k'));

    expect(clock.pendingTimers).to.equal(0);
  });
});
