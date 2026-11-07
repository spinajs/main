/** A driver handle that can stop and restart the rows it pushes. */
export interface PausableSource {
  pause(): void;
  resume(): void;
}

/**
 * Buffers the rows an event-emitting driver pushes and hands them out through an async iterator. The source is paused
 * while `highWaterMark` rows wait and resumed once the consumer has taken them all.
 */
export class RowQueue {
  private readonly rows: unknown[] = [];
  private paused = false;
  private ended = false;
  private discarding = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly source: PausableSource,
    private readonly highWaterMark: number,
  ) {}

  public push(row: unknown): void {
    if (this.discarding) {
      return;
    }

    this.rows.push(row);
    if (!this.paused && this.rows.length >= this.highWaterMark) {
      this.paused = true;
      this.source.pause();
    }
    this.notify();
  }

  public end(): void {
    this.ended = true;
    this.notify();
  }

  public fail(error: Error): void {
    this.failure ??= error;
    this.ended = true;
    this.notify();
  }

  public async *read(): AsyncGenerator<unknown> {
    for (;;) {
      if (this.rows.length > 0) {
        const row = this.rows.shift();
        if (this.paused && this.rows.length === 0 && !this.ended) {
          this.paused = false;
          this.source.resume();
        }
        yield row;
        continue;
      }

      if (this.failure) {
        throw this.failure;
      }

      if (this.ended) {
        return;
      }

      await this.waitForChange();
    }
  }

  /** Drops what is buffered and what still arrives, and resolves once the source has ended: a connection that is kept must be idle again. */
  public async discard(): Promise<void> {
    this.discarding = true;
    this.rows.length = 0;

    if (this.paused) {
      this.paused = false;
      this.source.resume();
    }

    while (!this.ended) {
      await this.waitForChange();
    }
  }

  private waitForChange(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}
