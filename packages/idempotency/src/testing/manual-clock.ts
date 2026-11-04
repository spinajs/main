import { Clock } from '@spinajs/durable';
import type { TimerHandle } from '@spinajs/durable';

interface ITimer {
  at: number;
  every?: number;
  fn: () => void;
}

const settle = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/** Timers fire only inside `advance()`, in due order, each followed by one macrotask turn so the work it started settles. */
export class ManualClock extends Clock {
  protected time: number;
  protected timers = new Map<number, ITimer>();
  protected seq = 0;

  constructor(start = Date.parse('2026-01-01T00:00:00.000Z')) {
    super();
    this.time = start;
  }

  public get pendingTimers(): number {
    return this.timers.size;
  }

  public now(): number {
    return this.time;
  }

  public setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.add({ at: this.time + Math.max(0, ms), fn });
  }

  public clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  public setInterval(fn: () => void, ms: number): TimerHandle {
    const every = Math.max(1, ms);
    return this.add({ at: this.time + every, every, fn });
  }

  public clearInterval(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  public async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (let next = this.due(end); next; next = this.due(end)) {
      const [id, timer] = next;
      this.time = timer.at;
      if (timer.every === undefined) {
        this.timers.delete(id);
      } else {
        timer.at += timer.every;
      }
      timer.fn();
      await settle();
    }
    this.time = end;
    await settle();
  }

  protected add(timer: ITimer): number {
    const id = ++this.seq;
    this.timers.set(id, timer);
    return id;
  }

  protected due(end: number): [number, ITimer] | undefined {
    let found: [number, ITimer] | undefined;
    for (const entry of this.timers) {
      if (entry[1].at <= end && (!found || entry[1].at < found[1].at)) {
        found = entry;
      }
    }
    return found;
  }
}
