import 'mocha';
import { expect } from 'chai';
import { currentContext, runInContext, SIM_EPOCH, SimClock, SimDbTimeSource } from '../src/index.js';

describe('SimClock', () => {
  it('starts at SIM_EPOCH and moves only when told to', () => {
    const clock = new SimClock();
    expect(clock.now()).to.equal(SIM_EPOCH);
    clock.advance(1500);
    expect(clock.now()).to.equal(SIM_EPOCH + 1500);
  });

  it('fires timers in due order, ties in creation order, at their due instant', () => {
    const clock = new SimClock(0);
    const seen: string[] = [];
    clock.setTimeout(() => seen.push(`b@${clock.now()}`), 20);
    clock.setTimeout(() => seen.push(`a@${clock.now()}`), 10);
    clock.setTimeout(() => seen.push(`c@${clock.now()}`), 20);
    clock.advance(25);
    expect(seen).to.deep.equal(['a@10', 'b@20', 'c@20']);
    expect(clock.now()).to.equal(25);
    expect(clock.pending).to.equal(0);
  });

  it('re-arms an interval from the instant it fired and stops it when cleared', () => {
    const clock = new SimClock(0);
    const seen: number[] = [];
    const handle = clock.setInterval(() => seen.push(clock.now()), 10);
    clock.advance(35);
    clock.clearInterval(handle);
    clock.advance(100);
    expect(seen).to.deep.equal([10, 20, 30]);
  });

  it('fires one timer per fireNext call and reports when nothing is due', () => {
    const clock = new SimClock(0);
    const seen: number[] = [];
    clock.setTimeout(() => seen.push(1), 5);
    clock.setTimeout(() => seen.push(2), 5);
    expect(clock.nextDue(10)).to.equal(5);
    expect(clock.fireNext(10)).to.equal(true);
    expect(seen).to.deep.equal([1]);
    expect(clock.fireNext(10)).to.equal(true);
    expect(clock.fireNext(10)).to.equal(false);
    expect(clock.nextDue(10)).to.equal(null);
  });

  it('never fires a cleared timeout', () => {
    const clock = new SimClock(0);
    const seen: number[] = [];
    clock.clearTimeout(clock.setTimeout(() => seen.push(1), 5));
    clock.advance(10);
    expect(seen).to.deep.equal([]);
  });

  it('jumps without firing; the overdue timer fires on the next advance at the current time', () => {
    const clock = new SimClock(0);
    const seen: number[] = [];
    clock.setTimeout(() => seen.push(clock.now()), 10);
    clock.jump(50);
    expect(seen).to.deep.equal([]);
    clock.advance(0);
    expect(seen).to.deep.equal([50]);
  });

  it('resolves Clock.sleep on advance and early on abort', async () => {
    const clock = new SimClock(0);
    const slept = clock.sleep(100);
    clock.advance(100);
    await slept;
    const ac = new AbortController();
    const aborted = clock.sleep(1_000_000, ac.signal);
    ac.abort();
    await aborted;
    expect(clock.pending).to.equal(0);
  });

  it('runs a callback in the async context that created the timer', () => {
    const clock = new SimClock(0);
    let seen: unknown;
    runInContext({ replica: 'r1', incarnation: 2 }, () => clock.setTimeout(() => (seen = currentContext()), 5));
    clock.advance(5);
    expect(seen).to.deep.equal({ replica: 'r1', incarnation: 2 });
  });

  it("holds a frozen replica's timers until it thaws", () => {
    const clock = new SimClock(0);
    const seen: string[] = [];
    runInContext({ replica: 'r1', incarnation: 1 }, () => clock.setTimeout(() => seen.push('r1'), 5));
    clock.setTimeout(() => seen.push('harness'), 5);
    clock.freeze('r1');
    clock.advance(10);
    expect(seen).to.deep.equal(['harness']);
    clock.thaw('r1');
    clock.advance(0);
    expect(seen).to.deep.equal(['harness', 'r1']);
  });

  it('drops the timers of a crashed incarnation and ignores the ones it creates later', () => {
    const clock = new SimClock(0);
    const seen: string[] = [];
    const old = { replica: 'r1', incarnation: 1 };
    runInContext(old, () => clock.setTimeout(() => seen.push('old'), 5));
    clock.dropOwner('r1#1');
    runInContext(old, () => clock.setTimeout(() => seen.push('late'), 5));
    runInContext({ replica: 'r1', incarnation: 2 }, () => clock.setTimeout(() => seen.push('new'), 5));
    clock.advance(10);
    expect(seen).to.deep.equal(['new']);
  });

  it('collects what a callback throws and keeps firing', () => {
    const clock = new SimClock(0);
    const seen: number[] = [];
    clock.setTimeout(() => {
      throw new Error('callback broke');
    }, 1);
    clock.setTimeout(() => seen.push(2), 2);
    clock.advance(5);
    expect(seen).to.deep.equal([2]);
    expect((clock.takeFailures()[0] as Error).message).to.equal('callback broke');
    expect(clock.takeFailures()).to.deep.equal([]);
  });

  it('refuses a negative or non-finite move and a non-finite timer delay; a negative delay is due now', () => {
    expect(() => new SimClock(0).advance(-1)).to.throw(RangeError);
    expect(() => new SimClock(0).jump(Number.NaN)).to.throw(RangeError);
    expect(() => new SimClock(0).setInterval(() => undefined, Number.NaN)).to.throw(RangeError);
    const clock = new SimClock(5);
    clock.setTimeout(() => undefined, -1);
    expect(clock.nextDue(5)).to.equal(5);
  });
});

describe('SimDbTimeSource', () => {
  it('reads the simulated time', async () => {
    expect(await new SimDbTimeSource(new SimClock(1234)).read()).to.equal(1234);
  });
});
