import FakeTimers from '@sinonjs/fake-timers';
import type { AuthnContext } from '@spinajs/authn/contracts';

const DEFAULT_IP = '192.0.2.10';

/** Moves `Date` only; timers, `performance.now()` and `process.hrtime` stay real. */
export class FakeClock {
  private ms: number;
  private timers: { setSystemTime(now: number): void; uninstall(): void } | null = null;

  constructor(start?: Date) {
    this.ms = (start ?? new Date(Math.floor(Date.now() / 1000) * 1000)).getTime();
  }

  get installed(): boolean {
    return this.timers !== null;
  }

  now(): Date {
    return new Date(this.ms);
  }

  tick(ms: number): void {
    if (!(ms >= 0)) {
      throw new RangeError('FakeClock.tick needs ms >= 0');
    }
    this.ms += ms;
    this.timers?.setSystemTime(this.ms);
  }

  set(at: Date): void {
    this.ms = at.getTime();
    this.timers?.setSystemTime(this.ms);
  }

  install(): void {
    if (this.timers) {
      return;
    }
    this.timers = FakeTimers.withGlobal(globalThis).install({ now: this.ms, toFake: ['Date'], shouldAdvanceTime: false });
  }

  uninstall(): void {
    this.timers?.uninstall();
    this.timers = null;
  }

  ctx(over?: Partial<AuthnContext>): AuthnContext {
    return { now: this.now(), ip: DEFAULT_IP, userAgent: 'authn-testing', purpose: 'login', ...over };
  }
}
