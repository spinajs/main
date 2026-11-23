import { performance } from 'node:perf_hooks';

/**
 * Wall-clock cost of one seed by phase; never part of the trace, which must stay identical between runs. The phases
 * are exclusive: what runs inside another phase is taken out of it, so they add up to at most `totalMs`.
 */
export interface SimProfile {
  /** `SimEnv.boot`: the test app, and the migrations or the copy of the migrated template (`bootFrom`). */
  bootMs: number;
  bootFrom: 'template' | 'migrations' | 'none';
  /** The rest of the suite's `build`. */
  buildMs: number;
  stepsMs: number;
  quiesceMs: number;
  checkMs: number;
  settleMs: number;
  settleCalls: number;
  shutdownMs: number;
  ticks: number;
  totalMs: number;
}

export type TimedPhase = 'bootMs' | 'buildMs' | 'stepsMs' | 'quiesceMs' | 'checkMs' | 'settleMs' | 'shutdownMs';

export class Profiler {
  protected readonly totals: Record<TimedPhase, number> = { bootMs: 0, buildMs: 0, stepsMs: 0, quiesceMs: 0, checkMs: 0, settleMs: 0, shutdownMs: 0 };
  protected readonly counts = { settleCalls: 0, ticks: 0 };
  /** Time spent in the phases running inside each open phase. The harness does one thing at a time, so a stack is enough. */
  protected readonly inner: number[] = [];
  protected from: SimProfile['bootFrom'] = 'none';
  protected readonly started = performance.now();

  constructor(public readonly enabled: boolean) {}

  public async time<T>(phase: TimedPhase, work: () => Promise<T>): Promise<T> {
    if (!this.enabled) return work();
    const t0 = performance.now();
    this.inner.push(0);
    try {
      return await work();
    } finally {
      const elapsed = performance.now() - t0;
      this.totals[phase] += elapsed - (this.inner.pop() ?? 0);
      if (this.inner.length > 0) this.inner[this.inner.length - 1] += elapsed;
    }
  }

  public count(what: 'settleCalls' | 'ticks'): void {
    if (this.enabled) this.counts[what]++;
  }

  public bootedFrom(from: 'template' | 'migrations'): void {
    this.from = from;
  }

  public result(): SimProfile | undefined {
    if (!this.enabled) return undefined;
    return { ...this.totals, ...this.counts, bootFrom: this.from, totalMs: performance.now() - this.started };
  }
}
