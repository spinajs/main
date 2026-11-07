import type express from 'express';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { UnexpectedServerError } from '@spinajs/exceptions';

import { ServerMiddleware } from './interfaces.js';
import type { HttpMiddleware, LegacyServerHandler, Request, Response } from './interfaces.js';
import { createServerAroundHandler } from './around.js';
import { enterMiddleware, sendReply, serverContextOf } from './reply-pipeline.js';
import type { ErrorReplier } from './reply-pipeline.js';
import { ErrorHandlerMiddleware } from './middlewares/ErrorHandler.js';

export interface IServerMountOptions {
  readonly log: Log;
  /** The error reply of a throwing server `onAfter` (D8): the global error answer's. */
  readonly errorReply: (req: express.Request) => ErrorReplier;
}

/** Whether the middleware still uses the deprecated `before()`/`after()`: it is then mounted through them only. */
export function isLegacyServerMiddleware(m: ServerMiddleware): boolean {
  return m.before !== ServerMiddleware.prototype.before || m.after !== ServerMiddleware.prototype.after;
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
    if (answer === undefined || answer === null) {
      next();
    } else if (!isResponse(answer)) {
      next(new UnexpectedServerError(`${name}.onBefore returned something that is not a Response`));
    } else {
      sendReply(req, res, answer, { errorReply: options.errorReply(req) }).catch(next);
    }
  };

  return named((req: express.Request, res: express.Response, next: express.NextFunction) => {
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

function inSequence(handlers: express.RequestHandler[], name: string): LegacyServerHandler {
  return named((req: express.Request, res: express.Response, next: express.NextFunction) => {
    let i = 0;
    const step = (err?: unknown) => {
      const handler = handlers[i++];
      if (err !== undefined || !handler) {
        next(err);
        return;
      }
      const result: unknown = handler(req, res, step);
      // as express 5 does for an async handler
      if (isThenable(result)) {
        Promise.resolve(result).catch(step);
      }
    };
    step();
  }, name) as LegacyServerHandler;
}

let mounting: IServerMountOptions | undefined;

/** Runs `mount` with the options of the HttpServer mounting a deprecated middleware, which its base before() uses. */
export function mountingWith<T>(options: IServerMountOptions, mount: () => T): T {
  const previous = mounting;
  mounting = options;
  try {
    return mount();
  } finally {
    mounting = previous;
  }
}

const rootOptions: IServerMountOptions = {
  get log() {
    return DI.resolve(Log, ['http']);
  },
  errorReply: (req) => (error) => globalErrorReplier(DI.resolve(ErrorHandlerMiddleware), req)(error),
};

// The deprecated base before(): a subclass still mounted through before() keeps getting its hooks from super.before().
(ServerMiddleware as unknown as Record<symbol, (m: ServerMiddleware) => LegacyServerHandler>)[Symbol.for('@spinajs/http.serverHooksHandler')] = (m) =>
  inSequence(serverMiddlewareHandlers(m, mounting ?? rootOptions), m.constructor.name);
