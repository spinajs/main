import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Clock, DbClock, DbTimeSource, FakeClock, SystemClock } from '../src/index.js';

describe('FakeClock', () => {
  it('starts at the given instant and fires timers on advance', async () => {
    const clock = new FakeClock('2026-01-05T10:00:00Z');
    const fired: number[] = [];
    clock.setTimeout(() => fired.push(clock.now()), 1500);
    const h = clock.setInterval(() => fired.push(-1), 1000);
    await clock.advance(2000);
    clock.clearInterval(h);
    expect(fired).to.deep.eq([-1, Date.parse('2026-01-05T10:00:01.500Z'), -1]);
  });

  it('jumps without firing timers on set', () => {
    const clock = new FakeClock(0);
    let fired = false;
    clock.setTimeout(() => (fired = true), 1000);
    clock.set(5000);
    expect(clock.now()).to.eq(5000);
    expect(fired).to.eq(false);
  });

  it('sleep resolves on abort and clears its timer', async () => {
    const clock = new FakeClock(0);
    const ac = new AbortController();
    const p = clock.sleep(10_000, ac.signal);
    ac.abort();
    await p;
    expect(clock.pendingTimers).to.eq(0);
  });

  it('db source reports local time plus skew', async () => {
    const clock = new FakeClock(1_000_000);
    clock.dbSkewMs = -30_000;
    expect(await clock.dbSource.read()).to.eq(970_000);
  });
});

describe('DbClock', () => {
  beforeEach(() => DI.clearCache());

  it('tracks the offset between local and database time', async () => {
    const clock = new FakeClock(1_000_000);
    clock.dbSkewMs = 45_000;
    DI.register(() => clock).as(Clock);
    DI.register(() => clock.dbSource).as(DbTimeSource);
    const db = DI.resolve(DbClock);
    expect(await db.sync()).to.eq(1_045_000);
    await clock.advance(1000);
    expect(db.now()).to.eq(1_046_000);
    expect(db.offset).to.eq(45_000);
  });
});

describe('SystemClock', () => {
  it('reports wall time', () => {
    expect(Math.abs(new SystemClock().now() - Date.now())).to.be.lessThan(1000);
  });
});
