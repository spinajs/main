import type { Clock, TimerHandle } from '../time/clock.js';

export interface HeartbeatOptions {
  timers: Clock;
  now: () => number;
  /** Timer period; progress is flushed at most this often. */
  intervalMs: number;
  /** Lease renewal period when nothing is dirty (leaseTtl / 3). */
  renewEveryMs: number;
  /** This long without a successful renewal means the lease is gone: another replica may reap the run. */
  leaseTtlMs: number;
  /** When the lease was taken (database time); defaults to construction. The loss clock and renewal period count from it. */
  leaseStartedAt?: number;
  needsFlush: () => boolean;
  /** Typically `LeaseStore.renewRun(run.Id, run.Attempt, scheduleLease, now, ctx.snapshot())`. */
  renew: () => Promise<{ ok: boolean; cancelRequested: boolean }>;
  /** Called at most once; the heartbeat stops renewing afterwards. */
  onLost: () => void;
  onCancel: () => void;
  /** A renewal that threw (e.g. the database is unreachable); it is retried on the next tick. */
  onError?: (err: unknown) => void;
}

/** One timer for both progress writes and lease renewal: every progress write renews the lease. */
export class Heartbeat {
  protected handle: TimerHandle | undefined;
  protected lastRenew: number;
  protected lastOk: number;
  protected inflight: Promise<void> = Promise.resolve();
  protected ticking = false;
  protected stopped = false;
  protected lost = false;

  constructor(protected readonly o: HeartbeatOptions) {
    this.lastRenew = this.lastOk = o.leaseStartedAt ?? o.now();
  }

  public start(): void {
    this.handle = this.o.timers.setInterval(() => this.tick(), this.o.intervalMs);
  }

  /** Waits for a renewal in flight, but never past the moment the lease is lost (a hanging renewal must not block). */
  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.handle !== undefined) this.o.timers.clearInterval(this.handle);
    if (this.lost) return;
    const ac = new AbortController();
    const remaining = Math.max(0, this.lastOk + this.o.leaseTtlMs - this.o.now());
    await Promise.race([this.inflight, this.o.timers.sleep(remaining, ac.signal)]);
    ac.abort();
  }

  /** Renews now, after any beat in flight; rejects with this beat's own error only. */
  public flush(): Promise<void> {
    return this.enqueue();
  }

  protected tick(): void {
    if (this.stopped || this.lost) return;
    // also catches a renewal that hangs instead of failing
    if (this.expired()) return this.markLost();
    // a slow database must not pile up queued beats
    if (this.ticking) return;
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
    if (this.lost) return;
    // the renewal extends the lease from about this instant, not from when it returns
    const startedAt = this.o.now();
    let r: { ok: boolean; cancelRequested: boolean };
    try {
      r = await this.o.renew();
    } catch (err) {
      this.o.onError?.(err);
      if (this.expired()) this.markLost();
      throw err;
    }
    this.lastRenew = this.o.now();
    if (!r.ok) return this.markLost();
    this.lastOk = startedAt;
    if (r.cancelRequested) this.o.onCancel();
  }

  protected expired(): boolean {
    return this.o.now() - this.lastOk >= this.o.leaseTtlMs;
  }

  protected markLost(): void {
    if (this.lost) return;
    this.lost = true;
    if (this.handle !== undefined) this.o.timers.clearInterval(this.handle);
    this.o.onLost();
  }
}
