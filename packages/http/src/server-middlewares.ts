import type express from 'express';
import type { Log } from '@spinajs/log';
import type { IContainer } from '@spinajs/di';
import { InvalidOperation, UnexpectedServerError } from '@spinajs/exceptions';

import type { HttpMiddleware, Request, Response, ServerMiddleware } from './interfaces.js';
import { createServerAroundHandler } from './around.js';
import { deliverReply, enterMiddleware, repliedInPlace, serverContextOf } from './reply-pipeline.js';
import type { ErrorReplier } from './reply-pipeline.js';
import type { ErrorHandlerMiddleware } from './middlewares/ErrorHandler.js';

export interface IServerMountOptions {
  readonly log: Log;
  /** The server's container: its `http.contractTesting` checks the answers of `onBefore`. */
  readonly container?: IContainer;
  /** The error reply of a throwing server `onAfter` (D8): the global error answer's. */
  readonly errorReply: (req: express.Request) => ErrorReplier;
}

/**
 * A 3.x `before()` or `after()` left on a server middleware, or on a NotFoundMiddleware or ErrorHandlerMiddleware
 * replacement, would be silently ignored; for an authentication middleware that means requests served unauthenticated.
 */
export function refuseRemovedHooks(m: object): void {
  const removed = ['before', 'after'].filter((name) => typeof (m as Record<string, unknown>)[name] === 'function');
  if (removed.length === 0) return;
  throw new InvalidOperation(
    `${m.constructor.name} defines ${removed.map((name) => `${name}()`).join(' and ')}, removed in @spinajs/http 4.0: implement onBefore, onAfter, onFinish, onAround or handler() (a NotFoundMiddleware or ErrorHandlerMiddleware replacement: reply())`,
  );
}

/** The reply a request no route answered gets for `error`, made by the (replaceable) `ErrorHandlerMiddleware`. */
export function globalErrorReplier(handler: ErrorHandlerMiddleware, req: express.Request): ErrorReplier {
  return async (error) => ({ response: await handler.reply(error, req as Request), error });
}

const isResponse = (value: unknown): value is Response => typeof (value as Response | null | undefined)?.execute === 'function';

const isThenable = (value: unknown): value is PromiseLike<unknown> => typeof (value as PromiseLike<unknown> | null | undefined)?.then === 'function';

const named = <T extends express.RequestHandler>(handler: T, name: string): T => {
  Object.defineProperty(handler, 'name', { value: name, writable: true });
  return handler;
};

const entersOnReach = (m: HttpMiddleware) => typeof m.onAfter === 'function' || typeof m.onFinish === 'function';

/**
 * An onBefore answering with a `Response` stops the chain: its reply goes out through the pipeline, so the server
 * middlewares entered so far see it. A synchronous onBefore goes on in the same tick.
 */
function createServerBeforeHandler(m: ServerMiddleware, enters: boolean, options: IServerMountOptions): express.RequestHandler {
  const name = m.constructor.name;
  const settle = (req: express.Request, res: express.Response, next: express.NextFunction, answer: unknown) => {
    if (enters) {
      enterMiddleware(res, 'server', m, serverContextOf(req, res));
    }
    // a deadline answered while this onBefore ran: the rest of the chain has nothing to answer
    if (repliedInPlace(res)) {
      return;
    }
    if (answer === undefined || answer === null) {
      next();
    } else if (!isResponse(answer)) {
      next(new UnexpectedServerError(`${name}.onBefore returned something that is not a Response`));
    } else {
      deliverReply(req, res, answer, { container: options.container, errorReply: options.errorReply(req) }).catch(next);
    }
  };

  return named((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (repliedInPlace(res)) {
      return;
    }
    let result: unknown;
    try {
      result = m.onBefore!(serverContextOf(req, res));
    } catch (err) {
      next(err);
      return;
    }
    if (isThenable(result)) {
      Promise.resolve(result)
        .then((answer) => settle(req, res, next, answer))
        .catch(next);
    } else {
      settle(req, res, next, result);
    }
  }, name);
}

function createServerEntryHandler(m: ServerMiddleware, handler?: express.RequestHandler): express.RequestHandler {
  return named((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (repliedInPlace(res)) {
      return;
    }
    enterMiddleware(res, 'server', m, serverContextOf(req, res));
    if (handler) {
      return handler(req, res, next);
    }
    next();
  }, m.constructor.name);
}

/**
 * The Express handlers of a server middleware, in mount order: `handler()` when it gives one, else the `onAround`
 * handler and the `onBefore` handler. A middleware reached by the chain is entered (its `onBefore` resolved, its
 * `onAround` started, its `handler()` called), and only an entered one gets `onAfter` and `onFinish`.
 */
export function serverMiddlewareHandlers(m: ServerMiddleware, options: IServerMountOptions): express.RequestHandler[] {
  const custom = m.handler?.();
  if (custom) {
    return [entersOnReach(m) ? createServerEntryHandler(m, custom) : custom];
  }

  const around = typeof m.onAround === 'function';
  return [
    ...(around ? [createServerAroundHandler(m as HttpMiddleware & Required<Pick<HttpMiddleware, 'onAround'>>, options.log)] : []),
    ...(typeof m.onBefore === 'function' ? [createServerBeforeHandler(m, !around && entersOnReach(m), options)] : []),
    ...(!around && typeof m.onBefore !== 'function' && entersOnReach(m) ? [createServerEntryHandler(m)] : []),
  ];
}
