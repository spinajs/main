import type { Clock, TimerHandle } from '@spinajs/durable';
import type { StepKind } from './contract.js';
import { NonDeterminismError } from './errors.js';
import type { StepRow } from './journal.js';

// Captured at load: a fake-timer library installed later (sinon.useFakeTimers in an app's tests) must not stall replays.
export const nextMacrotask = setImmediate;

interface Waiter {
  resolve(): void;
  reject(err: unknown): void;
}

interface HeldDelivery {
  order: number;
  resolve(): void;
}

/** Operations whose recorded result run() awaits; markers return synchronously and are never gated. */
const DELIVERED_KINDS = new Set<StepKind>(['step', 'sleep', 'wait', 'emit']);

export interface StallTimer {
  timers: Clock;
  ms: number;
}

/**
 * Replays recorded step results in the order the original run delivered them (`Meta.order`), gated on causality.
 * Every call records `Meta.after`, the number of results delivered before it; the r-th recorded result is released
 * only once every recorded call with `after < r` has been made again, and at most one result is released per
 * macrotask, as each one arrived from its own I/O the first time. Live results that complete while recorded ones are
 * still due are held until the replay is done, so they keep their place after them. The stall timer only turns a
 * replay that waits for a call that never comes into an error.
 */
export class ReplayGate {
  /** Results delivered to run() in this activation, recorded and live. */
  public delivered = 0;
  protected readonly order: string[];
  protected readonly remaining: Set<string>;
  protected readonly uncalled = new Map<string, number>();
  /** Uncalled recorded calls per `after`, and the distinct `after` values ascending, for an O(1) dependency check. */
  protected readonly uncalledAt = new Map<number, number>();
  protected readonly afters: number[];
  protected lowest = 0;
  protected readonly waiting = new Map<string, Waiter>();
  protected readonly held: HeldDelivery[] = [];
  protected cursor = 0;
  protected scheduled = false;
  protected aborted = false;
  protected stall?: TimerHandle;

  constructor(rows: StepRow[], causal: boolean, protected readonly onStall: (err: NonDeterminismError) => void, protected readonly stallTimer?: StallTimer) {
    const recorded = causal ? rows.filter((r) => r.Kind !== 'compensate') : [];
    const ordered = recorded.filter((r) => DELIVERED_KINDS.has(r.Kind) && typeof r.Meta?.order === 'number');
    this.order = ordered.sort((a, b) => (a.Meta?.order ?? 0) - (b.Meta?.order ?? 0)).map((r) => r.Key);
    this.remaining = new Set(this.order);
    for (const r of recorded) {
      const after = r.Meta?.after ?? 0;
      this.uncalled.set(r.Key, after);
      this.uncalledAt.set(after, (this.uncalledAt.get(after) ?? 0) + 1);
    }
    this.afters = [...this.uncalledAt.keys()].sort((a, b) => a - b);
  }

  public call(key: string): void {
    const after = this.uncalled.get(key);
    if (after === undefined) return;
    this.uncalled.delete(key);
    this.uncalledAt.set(after, (this.uncalledAt.get(after) ?? 1) - 1);
    while (this.lowest < this.afters.length && this.uncalledAt.get(this.afters[this.lowest]) === 0) this.lowest++;
    this.schedule();
  }

  /** Resolves when the recorded result of `key` may be handed to run(). */
  public wait(key: string): Promise<void> {
    if (!this.remaining.has(key) || this.aborted) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.waiting.set(key, { resolve, reject });
      this.schedule();
    });
  }

  /** Resolves when a live result journaled with `order` may be handed to run(). */
  public live(order: number | undefined): Promise<void> {
    if (this.aborted || (this.cursor >= this.order.length && this.held.length === 0)) {
      this.delivered++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.held.push({ order: order ?? Number.MAX_SAFE_INTEGER, resolve });
      this.held.sort((a, b) => a.order - b.order);
      this.schedule();
    });
  }

  /** The activation ended: recorded waiters fail with `err`, held live results are handed over. */
  public abort(err: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.clearStall();
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
    for (const h of this.held.splice(0)) h.resolve();
  }

  protected schedule(): void {
    if (this.scheduled || this.aborted) return;
    this.scheduled = true;
    nextMacrotask(() => {
      this.scheduled = false;
      this.releaseOne();
    });
  }

  protected releaseOne(): void {
    if (this.aborted) return;
    const next = this.order[this.cursor];
    const waiter = next === undefined ? undefined : this.waiting.get(next);
    let progressed = false;
    if (waiter && !this.blocked()) {
      this.waiting.delete(next);
      this.remaining.delete(next);
      this.cursor++;
      this.delivered++;
      waiter.resolve();
      progressed = true;
    } else if (next === undefined && this.held.length > 0) {
      this.delivered++;
      this.held.shift()?.resolve();
      progressed = true;
    }
    if (progressed) {
      this.clearStall();
      this.schedule();
    }
    if (this.stall === undefined && (this.waiting.size > 0 || this.held.length > 0) && this.stallTimer) {
      this.stall = this.stallTimer.timers.setTimeout(() => this.stalled(), this.stallTimer.ms);
    }
  }

  /** A recorded call made before the next result in the original run has not been made again. */
  protected blocked(): boolean {
    return this.lowest < this.afters.length && this.afters[this.lowest] <= this.cursor;
  }

  protected clearStall(): void {
    if (this.stall === undefined) return;
    this.stallTimer?.timers.clearTimeout(this.stall);
    this.stall = undefined;
  }

  protected stalled(): void {
    this.stall = undefined;
    const missing = [...this.uncalled].filter(([, after]) => after <= this.cursor).map(([key]) => key);
    const what = missing.length > 0 ? missing.slice(0, 3).join("', '") : this.order[this.cursor] ?? '';
    this.onStall(new NonDeterminismError(`the replay is waiting for '${what}', which the journal recorded and this run has not asked for`));
  }
}
