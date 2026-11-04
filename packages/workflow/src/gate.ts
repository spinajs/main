import type { Clock, TimerHandle } from '@spinajs/durable';
import { NonDeterminismError } from './errors.js';
import type { StepRow } from './journal.js';

interface Waiter {
  resolve(): void;
  reject(err: unknown): void;
}

export interface StallTimer {
  timers: Clock;
  ms: number;
}

const byOrder = (a: StepRow, b: StepRow): number => (a.Meta?.order ?? 0) - (b.Meta?.order ?? 0);

/**
 * Replays recorded step results in the order the original run delivered them (`Meta.order`), gated on causality.
 * Every call records `Meta.after`, the number of results delivered before it, so the r-th recorded result is
 * released only once every recorded call with `after < r` has been made again: a branch that was still on its way
 * to a call (in a microtask, a `setImmediate`, a file read) when the next result arrived is waited for.
 * Purely event-driven; the stall timer only turns a replay that waits for a call that never comes into an error.
 */
export class ReplayGate {
  /** Results delivered to run() in this activation, recorded and live. */
  public delivered = 0;
  protected readonly order: StepRow[];
  protected readonly uncalled = new Map<string, number>();
  protected readonly waiting = new Map<string, Waiter>();
  protected cursor = 0;
  protected stall?: TimerHandle;

  constructor(rows: StepRow[], causal: boolean, protected readonly stallTimer?: StallTimer) {
    const recorded = causal ? rows.filter((r) => r.Kind !== 'compensate') : [];
    this.order = recorded.filter((r) => r.Kind === 'step' && typeof r.Meta?.order === 'number').sort(byOrder);
    for (const r of recorded) this.uncalled.set(r.Key, r.Meta?.after ?? 0);
  }

  public call(key: string): void {
    if (this.uncalled.delete(key)) this.pump();
  }

  public wait(key: string): Promise<void> {
    if (!this.order.slice(this.cursor).some((r) => r.Key === key)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.waiting.set(key, { resolve, reject });
      this.pump();
    });
  }

  protected pump(): void {
    const from = this.cursor;
    while (this.cursor < this.order.length) {
      const key = this.order[this.cursor].Key;
      const waiter = this.waiting.get(key);
      if (!waiter || this.missing().length > 0) break;
      this.waiting.delete(key);
      this.cursor++;
      this.delivered++;
      waiter.resolve();
    }
    if (this.stall !== undefined && (this.cursor !== from || this.waiting.size === 0)) {
      this.stallTimer?.timers.clearTimeout(this.stall);
      this.stall = undefined;
    }
    if (this.stall === undefined && this.waiting.size > 0 && this.stallTimer) this.stall = this.stallTimer.timers.setTimeout(() => this.stalled(), this.stallTimer.ms);
  }

  /** Recorded calls the next release depends on that this run has not made. */
  protected missing(): string[] {
    return [...this.uncalled].filter(([, after]) => after <= this.cursor).map(([key]) => key);
  }

  protected stalled(): void {
    const missing = this.missing().slice(0, 3).join("', '");
    const err = new NonDeterminismError(`the replay is waiting for '${missing}', which the journal recorded and this run has not asked for`);
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
    this.stall = undefined;
  }
}
