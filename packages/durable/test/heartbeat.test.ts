import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Heartbeat, HeartbeatOptions } from '../src/index.js';
import { FakeClock } from '../src/testing/index.js';

chai.use(chaiAsPromised);

const T = Date.parse('2026-01-05T10:00:00Z');

describe('Heartbeat', () => {
  function make(
    clock: FakeClock,
    renew: () => Promise<{ ok: boolean; cancelRequested: boolean }>,
    dirty = () => false,
    extra: Partial<HeartbeatOptions> = {},
  ) {
    const calls = { lost: 0, cancel: 0, errors: 0 };
    const hb = new Heartbeat({
      timers: clock,
      now: () => clock.now(),
      intervalMs: 1000,
      renewEveryMs: 20_000,
      leaseTtlMs: 60_000,
      needsFlush: dirty,
      renew,
      onLost: () => calls.lost++,
      onCancel: () => calls.cancel++,
      onError: () => calls.errors++,
      ...extra,
    });
    return { hb, calls };
  }

  it('renews when due and flushes early when dirty', async () => {
    const clock = new FakeClock(T);
    let renewals = 0;
    let isDirty = false;
    const { hb } = make(
      clock,
      async () => (renewals++, { ok: true, cancelRequested: false }),
      () => isDirty,
    );
    hb.start();
    await clock.advance(19_000);
    expect(renewals).to.eq(0);
    await clock.advance(1000);
    await hb.flush();
    expect(renewals).to.eq(2);
    isDirty = true;
    await clock.advance(1000);
    await hb.stop();
    expect(renewals).to.eq(3);
  });

  it('keeps beating after a renewal that threw', async () => {
    const clock = new FakeClock(T);
    let calls = 0;
    const { hb, calls: seen } = make(clock, async () => {
      if (++calls === 1) throw new Error('db down');
      return { ok: true, cancelRequested: false };
    });
    await expect(hb.flush()).to.be.rejectedWith('db down');
    await hb.flush();
    await hb.stop();
    expect(calls).to.eq(2);
    expect(seen.lost).to.eq(0);
  });

  it('reports the lease lost once renewals have failed for a whole TTL, and stops renewing', async () => {
    const clock = new FakeClock(T);
    let renewals = 0;
    const { hb, calls } = make(clock, async () => {
      renewals++;
      throw new Error('db unreachable');
    });
    hb.start();
    await clock.advance(59_000);
    expect(calls.lost).to.eq(0);
    expect(calls.errors).to.eq(renewals).and.to.be.greaterThan(1);
    await clock.advance(1000);
    expect(calls.lost).to.eq(1);
    const after = renewals;
    await clock.advance(10_000);
    await hb.stop();
    expect(calls.lost).to.eq(1);
    expect(renewals).to.eq(after);
  });

  it('reports the lease lost while a renewal hangs past the TTL', async () => {
    const clock = new FakeClock(T);
    const { hb, calls } = make(clock, () => new Promise(() => undefined));
    hb.start();
    await clock.advance(60_000);
    expect(calls.lost).to.eq(1);
    await hb.stop();
  });

  it('stops waiting for a hanging renewal once the lease would have expired', async () => {
    const clock = new FakeClock(T);
    const { hb, calls } = make(clock, () => new Promise(() => undefined));
    hb.start();
    await clock.advance(20_000);
    let stopped = false;
    void hb.stop().then(() => (stopped = true));
    await clock.advance(39_000);
    expect(stopped).to.eq(false);
    await clock.advance(1000);
    expect(stopped).to.eq(true);
    expect(calls.lost).to.eq(0);
  });

  it('waits for a hanging renewal at most the given time when stopping', async () => {
    const clock = new FakeClock(T);
    const { hb } = make(clock, () => new Promise(() => undefined));
    hb.start();
    await clock.advance(20_000);
    let stopped = false;
    void hb.stop(5000).then(() => (stopped = true));
    await clock.advance(4000);
    expect(stopped).to.eq(false);
    await clock.advance(1000);
    expect(stopped).to.eq(true);
  });

  it('counts the lease from leaseStartedAt, not from construction', async () => {
    const clock = new FakeClock(T);
    let renewals = 0;
    const { hb, calls } = make(
      clock,
      async () => {
        renewals++;
        throw new Error('db unreachable');
      },
      () => false,
      { leaseStartedAt: T - 50_000 },
    );
    hb.start();
    await clock.advance(1000);
    expect(renewals).to.eq(1);
    await clock.advance(8000);
    expect(calls.lost).to.eq(0);
    await clock.advance(1000);
    expect(calls.lost).to.eq(1);
    await hb.stop();
  });

  it('calls onLost once and stops renewing after a renewal reports the lease gone', async () => {
    const clock = new FakeClock(T);
    let renewals = 0;
    const { hb, calls } = make(
      clock,
      async () => (renewals++, { ok: false, cancelRequested: false }),
      () => true,
    );
    hb.start();
    await clock.advance(5000);
    await hb.flush();
    await hb.stop();
    expect(renewals).to.eq(1);
    expect(calls.lost).to.eq(1);
  });

  it('does not pile up beats while a renewal is pending', async () => {
    const clock = new FakeClock(T);
    let renewals = 0;
    let release!: () => void;
    const { hb } = make(
      clock,
      () => {
        renewals++;
        return new Promise((resolve) => (release = () => resolve({ ok: true, cancelRequested: false })));
      },
      () => true,
    );
    hb.start();
    await clock.advance(5000);
    expect(renewals).to.eq(1);
    release();
    await clock.advance(1000);
    expect(renewals).to.eq(2);
    release();
    await hb.stop();
  });

  it('reports a lost lease and a cancel request', async () => {
    const clock = new FakeClock(T);
    const lost = make(clock, async () => ({ ok: false, cancelRequested: false }));
    await lost.hb.flush();
    expect(lost.calls.lost).to.eq(1);
    const cancel = make(clock, async () => ({ ok: true, cancelRequested: true }));
    await cancel.hb.flush();
    expect(cancel.calls.cancel).to.eq(1);
  });
});
