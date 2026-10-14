import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';

import { KeyedBackoff } from './keyed-backoff.js';
import type { BackoffParams, KeyedBackoffGate, KeyedBackoffOptions, KeyedBackoffRow, KeyedBackoffVerdict } from './keyed-backoff.js';
import type { ThrottleGate, ThrottleLower, ThrottleStore } from './throttle.js';

export interface MemoryThrottleStoreOptions {
  /** Every flow the store serves; each gets its own table. */
  readonly flows: readonly string[];
  /** Rows per flow, see `KeyedBackoffOptions`. */
  readonly maxRows: number;
  readonly resetAfterMs: number;
  /** Per flow; an attempt sweeps every other flow with a quarter of it. Default 8. */
  readonly sweepBatch?: number;
  readonly fullRetryMs?: number;
  readonly holdOffMs?: number;
  readonly delay?: (p: BackoffParams, n: number) => number;
  /** Called once per full episode of a flow's table, see `KeyedBackoffOptions.onFull`. */
  readonly onFull?: (flow: string) => void;
  /** Builds a flow's table. Default `new KeyedBackoff(options)`; it must return a new `KeyedBackoff` per flow. */
  readonly limiter?: (flow: string, options: KeyedBackoffOptions) => KeyedBackoff;
}

const toGate = ({ id, backoff }: ThrottleGate): KeyedBackoffGate => ({ key: id, backoff });

/**
 * A `ThrottleStore` in memory, for a single process: one `KeyedBackoff` per flow, so traffic in one flow never
 * evicts another flow's rows. No method awaits, so each call is atomic.
 */
export class MemoryThrottleStore implements ThrottleStore {
  private readonly limiters = new Map<string, KeyedBackoff>();
  private readonly flows: readonly string[];
  private readonly otherSweepBatch: number;

  constructor(private readonly options: MemoryThrottleStoreOptions) {
    this.flows = [...options.flows];
    this.otherSweepBatch = Math.ceil((options.sweepBatch ?? 8) / 4);
  }

  async attempt(flow: string, gates: readonly ThrottleGate[], counted: readonly string[], nowMs: number): Promise<KeyedBackoffVerdict> {
    const limiter = this.limiter(flow);
    // The flow's own attempt sweeps its full batch.
    for (const [other, l] of this.limiters) if (other !== flow) l.sweep(nowMs, this.otherSweepBatch);
    return limiter.attempt(gates.map(toGate), counted, nowMs);
  }

  /** A full table refuses only `attempt`. */
  async peek(flow: string, gates: readonly ThrottleGate[], nowMs: number): Promise<KeyedBackoffVerdict> {
    return this.limiter(flow).peek(gates.map(toGate), nowMs);
  }

  async succeed(flow: string, lower: readonly ThrottleLower[], clear: readonly string[], _nowMs: number): Promise<void> {
    const limiter = this.limiter(flow);
    for (const { targets, by } of lower) this.lower(limiter, targets, by);
    limiter.release();
    for (const id of clear) limiter.delete(id);
  }

  /** The flow's table (tests, diagnostics). The first call for any flow builds them all, so a factory that shares one fails at once. */
  limiter(flow: string): KeyedBackoff {
    if (!this.flows.includes(flow)) throw new InvalidArgument(`MemoryThrottleStore: unknown flow ${JSON.stringify(String(flow))}`);
    if (this.limiters.size === 0) this.build();
    return this.limiters.get(flow)!;
  }

  /** Takes off a target only the `by` rows whose run began after the target's: older ones counted attempts it never saw. */
  private lower(limiter: KeyedBackoff, targets: readonly ThrottleGate[], by: readonly string[]): void {
    const spent: Readonly<KeyedBackoffRow>[] = [];
    for (const id of by) {
      // Without expiry: a stale row still holds attempts its target counted.
      const row = limiter.row(id);
      if (row) spent.push(row);
      limiter.delete(id);
    }
    for (const { id, backoff } of targets) {
      const row = limiter.row(id);
      if (!row) continue;
      // Several `by` rows of one success counted the same attempts, so the largest is taken, never the sum.
      limiter.lower(
        id,
        spent.reduce((n, s) => (s.run > row.run ? Math.max(n, s.attempts) : n), 0),
        backoff,
      );
    }
  }

  private build(): void {
    const { maxRows, resetAfterMs, sweepBatch, fullRetryMs, holdOffMs, delay, onFull } = this.options;
    const make = this.options.limiter ?? ((_flow: string, o: KeyedBackoffOptions) => new KeyedBackoff(o));
    const built = new Map<string, KeyedBackoff>();
    for (const flow of this.flows) {
      const limiter: unknown = make(flow, { maxRows, resetAfterMs, sweepBatch, fullRetryMs, holdOffMs, delay, onFull: onFull && (() => onFull(flow)) });
      if (!(limiter instanceof KeyedBackoff)) {
        const what = (limiter as object | null | undefined)?.constructor?.name ?? String(limiter);
        throw new InvalidOperation(`MemoryThrottleStore: the limiter factory returned ${what} for the ${flow} flow, not a KeyedBackoff`);
      }
      for (const [other, l] of built) {
        if (l === limiter) throw new InvalidOperation(`MemoryThrottleStore: the limiter factory returned one ${limiter.constructor.name} for the ${other} and ${flow} flows; each flow needs its own instance`);
      }
      built.set(flow, limiter);
    }
    for (const [flow, limiter] of built) this.limiters.set(flow, limiter);
  }
}
