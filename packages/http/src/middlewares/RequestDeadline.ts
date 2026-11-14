import { Injectable, NewInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { Logger, Log } from '@spinajs/log';

import { HTTP_STATUS_CODE, RouteMiddleware, ServerMiddleware } from '../interfaces.js';
import type { IFinishContext, IMiddlewareContext } from '../interfaces.js';
import { Middleware } from '../decorators.js';
import { replyStarted, sendReplyInPlace } from '../reply-pipeline.js';
import { RawJsonResponse } from '../response-methods/rawJson.js';
import { redactUrl } from '../util/redact-url.js';

export interface IDeadlineConfiguration {
  enabled?: boolean;
  /** Milliseconds a request may take. */
  ms?: number;
}

const DEADLINE_BODY = Object.freeze({ error: Object.freeze({ code: 'deadline_exceeded', message: 'The request took too long' }) });

interface IDeadline {
  readonly controller: AbortController;
  at: number;
  timer?: ReturnType<typeof setTimeout>;
}

const DEADLINE = Symbol('requestDeadline');

const deadlineOf = (ctx: IMiddlewareContext) => (ctx.res.locals as Record<symbol, IDeadline | undefined>)[DEADLINE];

/** Starts the deadline of the request, or moves it earlier; a later one than the current is ignored. */
function armDeadline(ctx: IMiddlewareContext, ms: number, log: Log): void {
  const locals = ctx.res.locals as Record<symbol, IDeadline | undefined>;
  let deadline = locals[DEADLINE];
  if (!deadline) {
    deadline = { controller: new AbortController(), at: Infinity };
    locals[DEADLINE] = deadline;
    ctx.storage.signal = deadline.controller.signal;
  }

  const at = Date.now() + ms;
  if (at >= deadline.at || deadline.controller.signal.aborted) {
    return;
  }
  deadline.at = at;
  ctx.storage.deadline = at;
  clearTimeout(deadline.timer);
  const armed = deadline;
  // unref: an open request keeps the process alive by its socket, the timer must not do it on its own
  deadline.timer = setTimeout(() => expire(ctx, armed, log), ms).unref();
}

function expire({ req, res }: IMiddlewareContext, deadline: IDeadline, log: Log): void {
  deadline.timer = undefined;
  const reason = new DOMException('The request deadline passed', 'TimeoutError');
  deadline.controller.abort(reason);
  if (replyStarted(res)) {
    return;
  }

  log.warn({ method: req.method, url: redactUrl(req.originalUrl) }, '${method} ${url} answered 504: nothing was sent by its deadline');
  sendReplyInPlace(req, res, new RawJsonResponse(HTTP_STATUS_CODE.GATEWAY_TIMEOUT, DEADLINE_BODY), { error: reason }).catch((error: unknown) => {
    log.error({ error, url: redactUrl(req.originalUrl) }, 'The 504 for ${url} could not be sent');
    if (!res.writableEnded) {
      res.destroy();
    }
  });
}

function disarmDeadline(ctx: IFinishContext): void {
  const deadline = deadlineOf(ctx);
  if (!deadline) {
    return;
  }
  clearTimeout(deadline.timer);
  deadline.timer = undefined;
  if (ctx.aborted && !deadline.controller.signal.aborted) {
    deadline.controller.abort(new DOMException('The client went away', 'AbortError'));
  }
}

/**
 * A deadline for every request, at Order -0.3. It puts an `AbortSignal` in `req.storage.signal` and the deadline in
 * `req.storage.deadline` (epoch ms). When the deadline passes, the signal aborts with a `TimeoutError`, and a request
 * nothing was sent for yet is answered 504 `{ error: { code: 'deadline_exceeded' } }` through the reply pipeline; the
 * reply the action makes after that is dropped. When the client goes away first, the signal aborts with an
 * `AbortError`. The action is never stopped: it stops when it passes the signal to its I/O.
 *
 * `@Deadline(ms)` on a route or a controller moves the deadline earlier, never later.
 *
 * Config:
 *   http.deadline.enabled  (default false)
 *   http.deadline.ms       (default 30000)
 */
@Injectable(ServerMiddleware)
export class RequestDeadline extends ServerMiddleware {
  @Config('http.deadline')
  protected Deadline: IDeadlineConfiguration | undefined;

  @Logger('http')
  protected Log!: Log;

  private ms?: number;

  constructor() {
    super();
    this.Order = -0.3;
  }

  public isEnabled(): boolean {
    return this.Deadline?.enabled === true;
  }

  public onBefore(ctx: IMiddlewareContext): void {
    armDeadline(ctx, (this.ms ??= this.Deadline?.ms ?? 30_000), this.Log);
  }

  public onFinish(ctx: IFinishContext): void {
    disarmDeadline(ctx);
  }
}

/** The route middleware of {@link Deadline}. */
@NewInstance()
export class DeadlineMiddleware extends RouteMiddleware {
  @Logger('http')
  protected Log!: Log;

  constructor(public readonly ms: number) {
    super();
  }

  public onBefore(ctx: IMiddlewareContext): void {
    armDeadline(ctx, this.ms, this.Log);
  }

  public onFinish(ctx: IFinishContext): void {
    disarmDeadline(ctx);
  }
}

/**
 * Moves the request's deadline to `ms` milliseconds from when the route's middlewares run, when that is earlier than
 * the `http.deadline` one; works without `RequestDeadline` too. See {@link RequestDeadline}.
 */
export function Deadline(ms: number) {
  if (!(Number.isFinite(ms) && ms > 0)) {
    throw new InvalidArgument('@Deadline needs a positive number of milliseconds');
  }
  return Middleware(DeadlineMiddleware, ms);
}
