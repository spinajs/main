import { _check_arg, _gte, _integer, _is_number, concurrencyLimiterStrategy } from '@spinajs/util';
import type { ConcurrencyLimiterStrategy } from '@spinajs/util';

const NEVER_ABORTED = new AbortController().signal;

/** Runs at most `max` tasks at once; the rest wait in FIFO order. */
export class ConcurrencyLimiter {
  private readonly strategy: ConcurrencyLimiterStrategy<unknown>;

  constructor(public readonly max: number) {
    _check_arg(_is_number(_integer(), _gte(1)))(max, 'max');
    this.strategy = concurrencyLimiterStrategy({ PermitLimit: max, QueueLimit: Number.POSITIVE_INFINITY });
  }

  public get active(): number {
    return this.strategy.stats.active;
  }

  public get queued(): number {
    return this.strategy.stats.queued;
  }

  public get peak(): number {
    return this.strategy.stats.peak;
  }

  /** Tasks started so far. */
  public get runs(): number {
    return this.strategy.stats.runs;
  }

  public run<T>(task: () => Promise<T>): Promise<T> {
    return this.strategy(task)({ Signal: NEVER_ABORTED, Properties: new Map() }) as Promise<T>;
  }
}
