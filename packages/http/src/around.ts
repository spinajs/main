import type Express from 'express';
import type { Log } from '@spinajs/log';
import { UnexpectedServerError } from '@spinajs/exceptions';
import type { IController, IRoute, IRouteInvocation, IRouteOutcome, Request, RouteMiddleware } from './interfaces.js';
import { RouteClientGone } from './exceptions.js';
import { markStage } from './errors/on-error.js';
import { attachResponseCapture, responseCaptureOf } from './response-capture.js';
import type { CapturedJsonReply } from './response-capture.js';

const ROUTE_ERROR = Symbol('routeError');

const isCrash = (error: unknown): boolean => (error as { crash?: unknown } | null | undefined)?.crash === true;

function routeErrorOf(res: Express.Response): unknown {
  return (res.locals as Record<symbol, unknown>)[ROUTE_ERROR];
}

const AROUNDS = Symbol('aroundsSettled');

/** One entry per around handler entered on this response, outermost first; each settles with its onAround. */
function aroundsOf(res: Express.Response): Promise<void>[] {
  const locals = res.locals as Record<symbol, Promise<void>[] | undefined>;
  return (locals[AROUNDS] ??= []);
}

/**
 * Error handler recording the chain's error for `proceed()`. Placed twice: an error raised by the response or by an
 * error handler skips the first one. An error with `crash: true` stands for a dead process, so once recorded it is
 * kept: an error handler that turned it into another error must not hide it.
 */
export function recordRouteError(err: unknown, _req: Express.Request, res: Express.Response, next: Express.NextFunction): void {
  if (!isCrash(routeErrorOf(res))) {
    (res.locals as Record<symbol, unknown>)[ROUTE_ERROR] = err;
  }
  next(err);
}

type AroundRouteMiddleware = RouteMiddleware & Required<Pick<RouteMiddleware, 'onAround'>>;

export const wrapsRoute = (m: RouteMiddleware): m is AroundRouteMiddleware => typeof m.onAround === 'function';

/** Express handler running `middleware.onAround`, whose `proceed()` runs the rest of the chain. */
export function createAroundHandler(middleware: AroundRouteMiddleware, route: IRoute, controller: IController, path: string, log: Log): Express.RequestHandler {
  const name = middleware.constructor.name;

  const handler = (req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
    markStage(res, 'middleware');

    // proceed() settles after the around middlewares it wraps settled, so nesting holds on the way out too
    const arounds = aroundsOf(res);
    const depth = arounds.length;
    let markSettled!: () => void;
    arounds.push(new Promise<void>((resolve) => (markSettled = resolve)));
    const afterInner = (settle: () => void) => void Promise.allSettled(arounds.slice(depth + 1)).then(settle);

    let gone = res.destroyed || res.closed;
    let proceeded = false;
    let chainStarted = false;
    let aroundSettled = false;
    let onGone: (() => void) | undefined;
    let onFinish: (() => void) | undefined;

    // watched from the entry: a client that leaves before proceed() fires no later close
    const watchClose = () => {
      gone = true;
      onGone?.();
    };
    const release = () => {
      res.off('close', watchClose);
      if (onFinish) {
        res.off('finish', onFinish);
      }
    };
    res.on('close', watchClose);

    const proceed = (): Promise<IRouteOutcome> => {
      if (proceeded || aroundSettled) {
        return Promise.reject(new UnexpectedServerError(`${name}.onAround called proceed() ${proceeded ? 'more than once' : 'after it settled'}`));
      }
      proceeded = true;

      return new Promise<IRouteOutcome>((resolve, reject) => {
        if (gone) {
          release();
          reject(new RouteClientGone({ beforeRoute: true }));
          return;
        }

        let reply: CapturedJsonReply | null = null;
        // an enclosing around middleware captured first: it must see the reply too
        const enclosing = responseCaptureOf(res);
        attachResponseCapture(res, {
          capture: (captured) => {
            reply = captured;
            enclosing?.capture(captured);
          },
        });

        onFinish = () => {
          release();
          const error = routeErrorOf(res);
          afterInner(() => resolve(error === undefined ? { reply } : { reply, error }));
        };
        onGone = () => {
          release();
          afterInner(() => reject(new RouteClientGone({ beforeRoute: false })));
        };
        res.once('finish', onFinish);

        chainStarted = true;
        next();
      });
    };

    const invocation: IRouteInvocation = { req, res, storage: (req as Request).storage, route, controller, path };

    const runAround = async () => {
      let failure: { error: unknown } | undefined;
      try {
        await middleware.onAround(invocation, proceed);
      } catch (error) {
        failure = { error };
      }
      aroundSettled = true;
      if (!proceeded) {
        release();
      }

      if (!failure) {
        if (!proceeded && !res.headersSent && !gone) {
          next(new UnexpectedServerError(`${name} ended the route ${path} without proceeding or answering it`));
        }
      } else if (!chainStarted && !res.headersSent && !gone) {
        next(failure.error);
      } else {
        log.error({ error: failure.error, middleware: name, route: path }, 'Around middleware ${middleware} of ${route} failed after the route ran or the client went away');
      }
      markSettled();
    };

    void runAround();
  };

  Object.defineProperty(handler, 'name', { value: name, writable: true });
  return handler;
}
