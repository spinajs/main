import FakeTimers from '@sinonjs/fake-timers';
import { Clock, DbTimeSource, TimerHandle } from '../time/clock.js';

type FakeTimerClock = ReturnType<typeof FakeTimers.createClock>;

const toMs = (v: string | number | Date) =>
  typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : v.getTime();

export class FakeDbTimeSource extends DbTimeSource {
  constructor(protected readonly clock: FakeClock) {
    super();
  }
  public read(): Promise<number> {
    return Promise.resolve(this.clock.now() + this.clock.dbSkewMs);
  }
}

/**
 * Test clock on a non-global `@sinonjs/fake-timers` clock, so mocha and the
 * database driver keep their real timers.
 */
export class FakeClock extends Clock {
  /** Database time minus local time; simulates replica clock skew. */
  public dbSkewMs = 0;
  public readonly dbSource: FakeDbTimeSource;
  protected readonly timers: FakeTimerClock;

  constructor(start: string | number | Date = 0) {
    super();
    this.timers = FakeTimers.createClock(toMs(start));
    this.dbSource = new FakeDbTimeSource(this);
  }

  public now(): number {
    return this.timers.now;
  }
  public setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.timers.setTimeout(fn, ms);
  }
  public clearTimeout(handle: TimerHandle): void {
    this.timers.clearTimeout(handle as never);
  }
  public setInterval(fn: () => void, ms: number): TimerHandle {
    return this.timers.setInterval(fn, ms);
  }
  public clearInterval(handle: TimerHandle): void {
    this.timers.clearInterval(handle as never);
  }

  public async advance(ms: number): Promise<void> {
    await this.timers.tickAsync(ms);
  }

  /** Jumps without firing the timers in between (simulates downtime). */
  public set(to: string | number | Date): void {
    this.timers.setSystemTime(toMs(to));
  }

  public get pendingTimers(): number {
    return this.timers.countTimers();
  }
}
