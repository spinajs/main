import { Autoinject, Injectable, Singleton } from '@spinajs/di';

export type TimerHandle = unknown;

export abstract class Clock {
  public abstract now(): number;
  public abstract setTimeout(fn: () => void, ms: number): TimerHandle;
  public abstract clearTimeout(handle: TimerHandle): void;
  public abstract setInterval(fn: () => void, ms: number): TimerHandle;
  public abstract clearInterval(handle: TimerHandle): void;

  public sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const onAbort = () => {
        this.clearTimeout(handle);
        resolve();
      };
      const handle = this.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

@Injectable(Clock)
export class SystemClock extends Clock {
  public now(): number {
    return Date.now();
  }
  public setTimeout(fn: () => void, ms: number): TimerHandle {
    return setTimeout(fn, ms);
  }
  public clearTimeout(handle: TimerHandle): void {
    clearTimeout(handle as NodeJS.Timeout);
  }
  public setInterval(fn: () => void, ms: number): TimerHandle {
    return setInterval(fn, ms);
  }
  public clearInterval(handle: TimerHandle): void {
    clearInterval(handle as NodeJS.Timeout);
  }
}

export abstract class DbTimeSource {
  public abstract read(): Promise<number>;
}

@Singleton()
@Injectable()
export class DbClock {
  @Autoinject(Clock)
  protected Local: Clock;

  @Autoinject(DbTimeSource)
  protected Source: DbTimeSource;

  protected offsetMs = 0;

  public get offset(): number {
    return this.offsetMs;
  }

  public async sync(): Promise<number> {
    const local = this.Local.now();
    const db = await this.Source.read();
    this.offsetMs = db - local;
    return db;
  }

  public now(): number {
    return this.Local.now() + this.offsetMs;
  }
}
