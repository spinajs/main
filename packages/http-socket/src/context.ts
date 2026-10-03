import { CommandRequest, SocketException } from '@spinajs/http-socket-common';
import { IConnectionRuntime, IRegisteredHandler, ISocketCallStorage, ISocketCommandContext } from './interfaces.js';
import { SocketConnection } from './connection.js';
import type { ServerStream } from './stream.js';

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export class SocketCommandContext implements ISocketCommandContext {
  public readonly kind = 'command' as const;
  public readonly receivedAt = Date.now();
  public handler?: IRegisteredHandler;
  public args?: unknown[];
  public rateRefusal?: unknown;
  /** set when the handler returned an async iterable: the reply is a stream and this sends it */
  public stream?: ServerStream;

  protected readonly controller = new AbortController();
  protected timer: ReturnType<typeof setTimeout> | null = null;
  protected deadlineAt = Number.POSITIVE_INFINITY;

  constructor(public readonly runtime: IConnectionRuntime, public readonly request: CommandRequest, public readonly storage: ISocketCallStorage) {}

  public get connection(): SocketConnection {
    return this.runtime.connection;
  }

  public get payload(): unknown {
    return this.request.payload;
  }

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public abort(reason: SocketException): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason);
    }
  }

  public armDeadline(ms: number | undefined): void {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0 || this.controller.signal.aborted) {
      return;
    }

    const at = this.receivedAt + ms;
    if (at >= this.deadlineAt) {
      return;
    }

    this.deadlineAt = at;
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.schedule(ms);
  }

  protected schedule(ms: number): void {
    // setTimeout fires at once for a delay above 2^31-1 ms; a longer deadline is reached in several steps
    this.timer = setTimeout(
      () => {
        if (Date.now() < this.deadlineAt) {
          this.schedule(ms);
          return;
        }
        this.abort(new SocketException('deadline_exceeded', `command ${this.request.name} exceeded its deadline of ${ms} ms`));
      },
      Math.min(MAX_TIMER_DELAY_MS, Math.max(0, this.deadlineAt - Date.now())),
    );
  }

  public dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
