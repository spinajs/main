import type Express from 'express';
import type { Log } from '@spinajs/log';
import { UnexpectedServerError } from '@spinajs/exceptions';
import type { HttpMiddleware, IController, IMiddlewareContext, IRoute, IRouteOutcome, Request, RouteMiddleware } from './interfaces.js';
import { RouteClientGone } from './exceptions.js';
import { markStage, noteRouteError, routeErrorOf } from './errors/on-error.js';
import { attachResponseCapture, responseCaptureOf } from './response-capture.js';
import type { CapturedJsonReply } from './response-capture.js';
import { answeredErrorOf, answeredEarly, enterMiddleware, routeContextOf, serverContextOf } from './reply-pipeline.js';

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
  noteRouteError(res, err);
  next(err);
}

type AroundRouteMiddleware = RouteMiddleware & Required<Pick<RouteMiddleware, 'onAround'>>;
type AroundMiddleware = HttpMiddleware & Required<Pick<HttpMiddleware, 'onAround'>>;

export const wrapsRoute = (m: RouteMiddleware): m is AroundRouteMiddleware => typeof m.onAround === 'function';

/** Where an around handler sits: in a route's chain, or before routing (a server middleware, which has no route). */
type AroundScope = { readonly route: IRoute; readonly controller: IController; readonly path: string } | 'server';

/** Express handler running `middleware.onAround`, whose `proceed()` runs the rest of the chain. */
export function createAroundHandler(middleware: AroundRouteMiddleware, route: IRoute, controller: IController, path: string, log: Log): Express.RequestHandler {
  return aroundHandler(middleware, { route, controller, path }, log);
}

/** {@link createAroundHandler} for a server middleware: its `proceed()` resolves with the error the reply answers, when one does. */
export function createServerAroundHandler(middleware: AroundMiddleware, log: Log): Express.RequestHandler {
  return aroundHandler(middleware, 'server', log);
}

function aroundHandler(middleware: AroundMiddleware, scope: AroundScope, log: Log): Express.RequestHandler {
  const name = middleware.constructor.name;
  const server = scope === 'server';
  const ended = server ? 'the request' : `the route ${scope.path}`;
  // entering only matters for onAfter and onFinish; a server one is not entered without them
  const enters = !server || typeof middleware.onAfter === 'function' || typeof middleware.onFinish === 'function';

  const handler = (req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
    if (answeredEarly(res)) {
      next();
      return;
    }
    let invocation: IMiddlewareContext;
    if (server) {
      invocation = serverContextOf(req, res);
    } else {
      markStage(res, 'middleware');
      invocation = routeContextOf(res) ?? { req, res, storage: (req as Request).storage, ...scope };
    }
    if (enters) {
      enterMiddleware(res, server ? 'server' : 'route', middleware, invocation);
    }

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
          const error = server ? (routeErrorOf(res) ?? answeredErrorOf(res)) : routeErrorOf(res);
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
          next(new UnexpectedServerError(`${name} ended ${ended} without proceeding or answering it`));
        }
      } else if (!chainStarted && !res.headersSent && !gone) {
        next(failure.error);
      } else {
        log.error({ error: failure.error, middleware: name, route: server ? 'every request' : scope.path }, 'Around middleware ${middleware} of ${route} failed after the route ran or the client went away');
      }
      markSettled();
    };

    void runAround();
  };

  Object.defineProperty(handler, 'name', { value: name, writable: true });
  return handler;
}
