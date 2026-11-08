import type express from 'express';
import type { IContainer } from '@spinajs/di';
import type { Configuration } from '@spinajs/configuration';
import type { Log } from '@spinajs/log';
import { InvalidOption } from '@spinajs/exceptions';

import { Response } from '../interfaces.js';
import { describeConfigEntry, resolveConfiguredTypes } from '../configured-types.js';
import type { Request, IRoute, IController, IOnErrorDescriptor } from '../interfaces.js';

/**
 * The part of the route chain an error was raised in.
 */
export type ErrorStage = 'policy' | 'middleware' | 'arguments' | 'action' | 'after';

export interface ErrorContext {
  readonly req: Request;
  readonly res: express.Response;
  readonly route: IRoute;
  readonly controller: IController;
  readonly stage: ErrorStage;
  readonly container: IContainer;
}

export type ErrorClass = abstract new (...args: any[]) => Error;
export type OnErrorResult = Error | Response | void;
export type OnErrorHandler<E extends Error = Error> = (err: E, ctx: ErrorContext) => OnErrorResult | Promise<OnErrorResult>;

export interface OnErrorOptions {
  readonly stages?: readonly ErrorStage[];
}

/** App-wide handler listed in `http.errors.handlers`; same contract as an `OnError` handler. */
export abstract class ErrorHandlerService {
  abstract readonly on: ErrorClass | readonly ErrorClass[];
  readonly stages?: readonly ErrorStage[];
  abstract handle(err: Error, ctx: ErrorContext): OnErrorResult | Promise<OnErrorResult>;
}

const ERROR_HANDLERS_KEY = 'http.errors.handlers';

const STAGE = Symbol('errorStage');

// Tolerates a response without `locals`: the route-builder helpers are also called with bare stubs.
export function markStage(res: express.Response | undefined, stage: ErrorStage): void {
  if (res?.locals) {
    (res.locals as Record<symbol, ErrorStage>)[STAGE] = stage;
  }
}

export function stageOf(res: express.Response | undefined): ErrorStage {
  return (res?.locals as Record<symbol, ErrorStage> | undefined)?.[STAGE] ?? 'action';
}

const ROUTE_ERROR = Symbol('routeError');

const isCrash = (error: unknown): boolean => (error as { crash?: unknown } | null | undefined)?.crash === true;

/** The error the route's reply answers, for `proceed()` of an around middleware. */
export function routeErrorOf(res: express.Response): unknown {
  return (res.locals as Record<symbol, unknown>)[ROUTE_ERROR];
}

/** An error with `crash: true` stands for a dead process, so once noted it is kept: a later error must not hide it. */
export function noteRouteError(res: express.Response, err: unknown): void {
  if (res.locals && !isCrash(routeErrorOf(res))) {
    (res.locals as Record<symbol, unknown>)[ROUTE_ERROR] = err;
  }
}

export function toErrorDescriptor(service: ErrorHandlerService): IOnErrorDescriptor {
  return {
    On: Array.isArray(service.on) ? (service.on as readonly ErrorClass[]) : [service.on as ErrorClass],
    Handler: service.handle.bind(service),
    Stages: service.stages,
  };
}

/**
 * Resolves the `http.errors.handlers` entries ( `{ service: '<ClassName>', ...options }` ), in config order; each
 * service gets its whole entry as its options.
 *
 * Not `@AutoinjectService`: it refuses an empty list when no ErrorHandlerService is registered, and `[]` is the default.
 */
export async function resolveConfigErrorHandlers(cfg: Configuration, container: IContainer): Promise<IOnErrorDescriptor[]> {
  const entries = cfg.get<unknown[]>(ERROR_HANDLERS_KEY, []) ?? [];
  if (entries.length === 0) {
    return [];
  }

  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || typeof (entry as { service?: unknown }).service !== 'string') {
      throw new InvalidOption(`${ERROR_HANDLERS_KEY}: entry ${describeConfigEntry(entry)} is not { service: '<ErrorHandlerService name>' }`);
    }
  }

  const services = await Promise.all(resolveConfiguredTypes(ERROR_HANDLERS_KEY, ErrorHandlerService, entries, container).map(({ type, entry }) => container.resolve<ErrorHandlerService>(type, [entry])));

  return services.map(toErrorDescriptor);
}

/** What the error handlers made of an error: an answer, or the error left for the error map. */
export interface IHandledError {
  readonly response?: Response;
  readonly error: unknown;
}

/**
 * Runs the route's, the controller's and the config handlers on `err`, in that order. See docs/http/11-error-handling.md
 * for the contract. A handler that throws is logged and the original error is left for the error map.
 */
export async function runErrorHandlers(descriptors: readonly IOnErrorDescriptor[], err: unknown, ctx: ErrorContext, log: Log): Promise<IHandledError> {
  let current = err;
  for (const d of descriptors) {
    if (d.Stages && !d.Stages.includes(ctx.stage)) continue;
    if (!d.On.some((t) => current instanceof t)) continue;

    let result: OnErrorResult;
    try {
      result = await d.Handler(current as Error, ctx);
    } catch (handlerError) {
      log.error(
        { controller: ctx.controller.constructor.name, route: String(ctx.route.Method), errorName: (handlerError as Error)?.name },
        'OnError handler failed for ${controller}::${route}; the original error is answered',
      );
      return { error: err };
    }

    if (result instanceof Response) {
      return { response: result, error: current };
    }

    if (result instanceof Error) {
      current = result;
    }
  }

  return { error: current };
}

/** Express error handler running {@link runErrorHandlers}: an answer goes to the route's sender, anything else on. */
export function createOnErrorHandler(
  descriptors: readonly IOnErrorDescriptor[],
  route: IRoute,
  controller: IController,
  container: IContainer,
  log: Log,
  answer: (res: express.Response, response: Response, error: unknown) => void = (res, response) => void (res.locals.response = response),
): express.ErrorRequestHandler {
  return (err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (descriptors.length === 0 || res.headersSent) {
      next(err);
      return;
    }

    runErrorHandlers(descriptors, err, { req: req as Request, res, route, controller, stage: stageOf(res), container }, log)
      .then(({ response, error }) => {
        if (response) {
          answer(res, response, error);
          next();
          return;
        }
        next(error);
      })
      .catch(() => next(err));
  };
}
