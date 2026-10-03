/** Runs at most `max` tasks at once; the rest wait in FIFO order. */
export class ConcurrencyLimiter {
  private _active = 0;
  private _peak = 0;
  private _runs = 0;
  private readonly _queue: (() => void)[] = [];

  constructor(public readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(`concurrency limit must be a positive integer, got ${max}`);
    }
  }

  public get active(): number {
    return this._active;
  }

  public get queued(): number {
    return this._queue.length;
  }

  public get peak(): number {
    return this._peak;
  }

  /** Tasks started so far. */
  public get runs(): number {
    return this._runs;
  }

  public async run<T>(task: () => Promise<T>): Promise<T> {
    if (this._active >= this.max) {
      // A finishing task hands its slot over without decrementing `_active`,
      // so no newcomer can take it before this waiter resumes.
      await new Promise<void>((res) => this._queue.push(res));
    } else {
      this._active++;
    }
    this._peak = Math.max(this._peak, this._active);
    this._runs++;

    try {
      return await task();
    } finally {
      const next = this._queue.shift();
      if (next) {
        next();
      } else {
        this._active--;
      }
    }
  }
}
