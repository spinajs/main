import { CommandRequest, SocketException } from '@spinajs/http-socket-common';
import { IConnectionRuntime, IRegisteredHandler, ISocketCallStorage, ISocketCommandContext } from './interfaces.js';
import { SocketConnection } from './connection.js';

export class SocketCommandContext implements ISocketCommandContext {
  public readonly kind = 'command' as const;
  public readonly receivedAt = Date.now();
  public handler?: IRegisteredHandler;
  public args?: unknown[];
  public rateRefusal?: unknown;

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
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
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

    this.timer = setTimeout(() => this.abort(new SocketException('deadline_exceeded', `command ${this.request.name} exceeded its deadline of ${ms} ms`)), Math.max(0, at - Date.now()));
  }

  public dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
