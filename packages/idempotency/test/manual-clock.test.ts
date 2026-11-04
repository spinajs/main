import 'mocha';
import { expect } from 'chai';
import { ManualClock } from '../src/testing/index.js';

describe('ManualClock', () => {
  it('fires timers only inside advance, in due order, intervals again and again', async () => {
    const clock = new ManualClock(0);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push(`t@${clock.now()}`), 50);
    const every = clock.setInterval(() => fired.push(`i@${clock.now()}`), 20);
    expect(fired).to.deep.equal([]);

    await clock.advance(60);
    expect(fired).to.deep.equal(['i@20', 'i@40', 't@50', 'i@60']);

    clock.clearInterval(every);
    await clock.advance(100);
    expect(fired).to.have.length(4);
    expect(clock.now()).to.equal(160);
    expect(clock.pendingTimers).to.equal(0);
  });

  it('lets the async work a timer started settle before the next timer fires', async () => {
    const clock = new ManualClock(0);
    const seen: number[] = [];
    clock.setTimeout(() => void Promise.resolve().then(() => seen.push(1)), 10);
    clock.setTimeout(() => seen.push(2), 20);
    await clock.advance(20);
    expect(seen).to.deep.equal([1, 2]);
  });

  it('resolves sleep once advanced past it, and at once when aborted', async () => {
    const clock = new ManualClock(0);
    let slept = false;
    const sleeping = clock.sleep(100).then(() => (slept = true));
    await clock.advance(99);
    expect(slept).to.equal(false);
    await clock.advance(1);
    await sleeping;
    expect(slept).to.equal(true);

    const controller = new AbortController();
    const aborted = clock.sleep(1_000, controller.signal);
    controller.abort();
    await aborted;
    expect(clock.pendingTimers).to.equal(0);
  });
});
