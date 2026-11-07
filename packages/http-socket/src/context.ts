import { CommandRequest, SocketException } from '@spinajs/http-socket-common';
import { CommandOutcome, IConnectionRuntime, IRegisteredHandler, ISocketCallStorage, ISocketFinishContext, ISocketIdempotencyClaim, ISocketOutcomeRecorder, ISocketReplyContext, SocketMiddleware } from './interfaces.js';
import { SocketConnection } from './connection.js';
import type { ServerStream } from './stream.js';

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

const OUTCOME_UNKNOWN = new WeakSet<object>();

/**
 * Marks an abort reason after which a started handler's outcome is unknown ( shutdown ): it may have committed and then
 * thrown the reason, so its key stays claimed instead of being released for a retry that would run it again. On a leased
 * store another instance takes the key over once the lease ends.
 */
export function outcomeUnknownAfter<T extends object>(reason: T): T {
  OUTCOME_UNKNOWN.add(reason);
  return reason;
}

export function isOutcomeUnknownAfter(reason: unknown): boolean {
  return typeof reason === 'object' && reason !== null && OUTCOME_UNKNOWN.has(reason);
}

/**
 * The command was aborted ( deadline, cancel, disconnect, shutdown ) before its handler started; `beforeHandler` says
 * the rest of the chain never ran. It carries the abort reason's code, message and retry hint, so it answers the client
 * as the reason does; the reason is its `cause`.
 */
export class SocketClientGone extends SocketException {
  public readonly beforeHandler: boolean;

  constructor(options: { beforeHandler: boolean }, reason: SocketException) {
    super(reason.code, reason.message, { details: reason.details, retryable: reason.retryable, retryAfterMs: reason.retryAfterMs, errorId: reason.errorId, cause: reason });
    this.name = 'SocketClientGone';
    this.beforeHandler = options.beforeHandler;
  }
}

export class SocketCommandContext implements ISocketReplyContext, ISocketFinishContext {
  public readonly kind = 'command' as const;
  public readonly receivedAt = Date.now();
  public handler?: IRegisteredHandler;
  public args?: unknown[];
  public rateRefusal?: unknown;
  public idempotency?: ISocketIdempotencyClaim;
  /** set when the handler returned an async iterable: the reply is a stream and this sends it */
  public stream?: ServerStream;
  public drainGrace = false;
  /** On the way out: the outcome the next `onAfter` sees. */
  public result?: unknown;
  public error?: unknown;
  /** @internal The entered middlewares that have `onFinish`, in entry order; unset until one is entered. */
  public finishing?: SocketMiddleware[];
  /** @internal Settles, never rejects, when the middleware chain has. */
  public chainSettled: Promise<void> = Promise.resolve();

  protected readonly controller = new AbortController();
  protected timer: ReturnType<typeof setTimeout> | null = null;
  protected deadlineAt = Number.POSITIVE_INFINITY;
  protected started = false;
  protected readonly recorders: ISocketOutcomeRecorder[] = [];

  constructor(public readonly runtime: IConnectionRuntime, public readonly request: CommandRequest, public readonly storage: ISocketCallStorage) {}

  public get handlerStarted(): boolean {
    return this.started;
  }

  public get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  /** @internal Called by the dispatcher when the chain enters a middleware. */
  public enter(middleware: SocketMiddleware): void {
    if (middleware.onFinish) {
      (this.finishing ??= []).push(middleware);
    }
  }

  /** @internal Called by the dispatcher right before the handler. */
  public markHandlerStarted(): void {
    this.started = true;
  }

  public addOutcomeRecorder(recorder: ISocketOutcomeRecorder): void {
    this.recorders.push(recorder);
  }

  public async recordOutcome(outcome: CommandOutcome): Promise<void> {
    await Promise.all(this.recorders.map((recorder) => Promise.resolve().then(() => recorder.settle(outcome)).catch(() => undefined)));
  }

  public detachOutcome(running: Promise<unknown>): void {
    for (const recorder of this.recorders) {
      try {
        recorder.detach(running);
      } catch {
        // as in recordOutcome: one failing recorder must not keep the others from the outcome
      }
    }
  }

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
    if (typeof ms !== 'number' || !Number.isFinite(ms) || this.controller.signal.aborted) {
      return;
    }

    if (ms <= 0) {
      this.abort(new SocketException('deadline_exceeded', `command ${this.request.name} arrived with its deadline already passed`));
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
