import type { Clock, TimerHandle } from '../time/clock.js';

export interface HeartbeatOptions {
  timers: Clock;
  now: () => number;
  /** Timer period; progress is flushed at most this often. */
  intervalMs: number;
  /** Lease renewal period when nothing is dirty (leaseTtl / 3). */
  renewEveryMs: number;
  needsFlush: () => boolean;
  /** Typically `LeaseStore.renewRun(run.Id, run.Attempt, scheduleLease, now, ctx.snapshot())`. */
  renew: () => Promise<{ ok: boolean; cancelRequested: boolean }>;
  onLost: () => void;
  onCancel: () => void;
}

/** One timer for both progress writes and lease renewal: every progress write renews the lease. */
export class Heartbeat {
  protected handle: TimerHandle | undefined;
  protected lastRenew: number;
  protected inflight: Promise<void> = Promise.resolve();
  protected ticking = false;
  protected stopped = false;

  constructor(protected readonly o: HeartbeatOptions) {
    this.lastRenew = o.now();
  }

  public start(): void {
    this.handle = this.o.timers.setInterval(() => this.tick(), this.o.intervalMs);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.handle !== undefined) this.o.timers.clearInterval(this.handle);
    await this.inflight;
  }

  /** Renews now, after any beat in flight; rejects with this beat's own error only. */
  public flush(): Promise<void> {
    return this.enqueue();
  }

  protected tick(): void {
    // a slow database must not pile up queued beats
    if (this.stopped || this.ticking) return;
    const due = this.o.now() - this.lastRenew >= this.o.renewEveryMs;
    if (!due && !this.o.needsFlush()) return;
    this.ticking = true;
    void this.enqueue()
      .catch(() => undefined)
      .finally(() => (this.ticking = false));
  }

  protected enqueue(): Promise<void> {
    const beat = this.inflight.then(() => this.beat());
    this.inflight = beat.catch(() => undefined);
    return beat;
  }

  protected async beat(): Promise<void> {
    const r = await this.o.renew();
    this.lastRenew = this.o.now();
    if (!r.ok) {
      this.o.onLost();
      return;
    }
    if (r.cancelRequested) this.o.onCancel();
  }
}
