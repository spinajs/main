import type express from 'express';
import type { IContainer } from '@spinajs/di';
import type { Log } from '@spinajs/log';

import type { Request, IRoute, IController, Response } from '../interfaces.js';
import { stageOf } from './on-error.js';
import type { ErrorStage } from './on-error.js';
import { answeredError, forgetAnswered } from './answered.js';

export interface ObservedErrorContext {
  readonly req: Request;
  /** The status the server answered the error with, also when the client left before it was delivered. */
  readonly status: number;
  /** Whether the answer reached the client: `false` when the connection closed before the response was complete. */
  readonly sent: boolean;
  /** Set for an error of a route chain; absent for one raised before routing, by a server middleware or for an unmatched path. */
  readonly route?: IRoute;
  readonly controller?: IController;
  readonly stage?: ErrorStage;
  /** The response an `@OnError` handler or an `ErrorHandlerService` answered the error with; absent when the error map answered it. */
  readonly answer?: Response;
}

/**
 * Sees every error the server answers, from a route chain or from before routing, once the answer is complete.
 * A throw or rejection of `observe()` is logged.
 */
export abstract class ErrorObserver {
  abstract observe(err: unknown, ctx: ObservedErrorContext): void | Promise<void>;
}

interface IObservedChain {
  readonly route: IRoute;
  readonly controller: IController;
}

/** Wraps the final error handler of a route chain or of the server so the observers see what it answers. */
export function observeErrors(handler: express.ErrorRequestHandler, container: IContainer, log: Log, chain?: IObservedChain): express.ErrorRequestHandler {
  return (err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err) {
      // Sending a route handler's answer failed: the error answered now replaces that answer.
      forgetAnswered(res);
      observeWhenAnswered(container, log, err, req, res, chain);
    }

    handler(err, req, res, next);
  };
}

/** Placed after the route error handlers: observes the error one of them answered with a response. */
export function observeAnsweredErrors(container: IContainer, log: Log, chain: IObservedChain): express.RequestHandler {
  return (req, res, next) => {
    const answered = answeredError(res);
    if (answered) {
      observeWhenAnswered(container, log, answered.error, req, res, chain, answered.answer, () => answeredError(res) === answered);
    }

    next();
  };
}

// Observers are resolved per error, so the route and the server path always see the same set: whatever is registered by then.
function observeWhenAnswered(
  container: IContainer,
  log: Log,
  err: unknown,
  req: express.Request,
  res: express.Response,
  chain?: IObservedChain,
  answer?: Response,
  stillCurrent: () => boolean = () => true,
): void {
  if ((container.getRegisteredTypes(ErrorObserver) ?? []).length === 0) {
    return;
  }

  whenEndedAndClosed(res, (sent) => {
    if (!stillCurrent()) {
      return;
    }

    const ctx: ObservedErrorContext = {
      req: req as Request,
      status: res.statusCode,
      sent,
      ...(chain ? { route: chain.route, controller: chain.controller, stage: stageOf(res) } : {}),
      ...(answer ? { answer } : {}),
    };
    void notify(container, log, err, ctx);
  });
}

/**
 * Runs `callback` once the answer has called `end()` (its status is final) and the connection has closed.
 * `end()` is wrapped because `close` can come before the status is set, when the client left first; waiting
 * for both makes the status the one the server chose either way. `writableFinished` alone does not say the
 * answer was delivered: Node sets it after an `end()` on a connection that is already gone.
 */
function whenEndedAndClosed(res: express.Response, callback: (sent: boolean) => void): void {
  let ended = res.writableEnded;
  let closed = res.closed;
  let closedFirst = closed && !ended;
  let done = false;
  const settle = () => {
    // Once the headers are out the status is final: a piped answer the client aborts never calls end().
    if (closed && (ended || res.headersSent) && !done) {
      done = true;
      callback(!closedFirst && res.writableFinished);
    }
  };

  if (!closed) {
    res.once('close', () => {
      closed = true;
      closedFirst = !ended;
      settle();
    });
  }

  if (!ended) {
    const end = res.end.bind(res);
    Object.defineProperty(res, 'end', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): unknown => {
        ended = true;
        const result: unknown = Reflect.apply(end, res, args);
        settle();
        return result;
      },
    });
  }

  settle();
}

async function notify(container: IContainer, log: Log, err: unknown, ctx: ObservedErrorContext): Promise<void> {
  let observers: ErrorObserver[];
  try {
    observers = await container.resolve(Array.ofType(ErrorObserver));
  } catch (resolveError) {
    log.error({ error: resolveError }, 'Error observers could not be resolved; the error was answered as usual');
    return;
  }

  for (const observer of observers) {
    try {
      await observer.observe(err, ctx);
    } catch (observerError) {
      log.error({ observer: observer.constructor.name, error: observerError }, 'Error observer ${observer} failed; the error was answered as usual');
    }
  }
}
