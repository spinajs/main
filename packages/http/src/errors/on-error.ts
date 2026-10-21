import type express from 'express';
import type { IContainer } from '@spinajs/di';
import type { Configuration } from '@spinajs/configuration';
import type { Log } from '@spinajs/log';
import { InvalidOption } from '@spinajs/exceptions';

import { Response } from '../interfaces.js';
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

const STAGE = Symbol('errorStage');

export function markStage(res: express.Response, stage: ErrorStage): void {
  (res.locals as Record<symbol, ErrorStage>)[STAGE] = stage;
}

export function stageOf(res: express.Response): ErrorStage {
  return (res.locals as Record<symbol, ErrorStage>)[STAGE] ?? 'action';
}

export function toErrorDescriptor(service: ErrorHandlerService): IOnErrorDescriptor {
  return {
    On: Array.isArray(service.on) ? (service.on as readonly ErrorClass[]) : [service.on as ErrorClass],
    Handler: service.handle.bind(service),
    Stages: service.stages,
  };
}

/**
 * Resolves the `http.errors.handlers` entries ( `{ service: '<ClassName>', ...options }` ), in config order.
 *
 * Not `@AutoinjectService`: it refuses an empty list when no ErrorHandlerService is registered, and `[]` is the default.
 */
export async function resolveConfigErrorHandlers(cfg: Configuration, container: IContainer): Promise<IOnErrorDescriptor[]> {
  const entries = cfg.get<{ service: string }[]>('http.errors.handlers', []) ?? [];
  if (entries.length === 0) {
    return [];
  }

  const types = container.getRegisteredTypes(ErrorHandlerService) ?? [];
  const services = await Promise.all(
    entries.map((entry) => {
      const type = types.find((t) => (t as { name?: string }).name === entry.service);
      if (!type) {
        throw new InvalidOption(`http.errors.handlers: no ErrorHandlerService named ${entry.service} is registered`);
      }
      return container.resolve<ErrorHandlerService>(type as any, [entry]);
    }),
  );

  return services.map(toErrorDescriptor);
}

/**
 * Express error handler running the route's, the controller's and the config handlers, in that order.
 * See docs/http/11-error-handling.md for the contract.
 */
export function createOnErrorHandler(descriptors: readonly IOnErrorDescriptor[], route: IRoute, controller: IController, container: IContainer, log: Log): express.ErrorRequestHandler {
  return (err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (descriptors.length === 0 || res.headersSent) {
      next(err);
      return;
    }

    const stage = stageOf(res);

    void (async () => {
      let current = err;
      for (const d of descriptors) {
        if (d.Stages && !d.Stages.includes(stage)) continue;
        if (!d.On.some((t) => current instanceof t)) continue;

        let result: OnErrorResult;
        try {
          result = await d.Handler(current as Error, { req: req as Request, res, route, controller, stage, container });
        } catch (handlerError) {
          log.error(
            { controller: controller.constructor.name, route: String(route.Method), errorName: (handlerError as Error)?.name },
            'OnError handler failed for ${controller}::${route}; the original error is answered',
          );
          next(err);
          return;
        }

        if (result instanceof Response) {
          res.locals.response = result;
          next();
          return;
        }

        if (result instanceof Error) {
          current = result;
        }
      }

      next(current);
    })().catch(() => next(err));
  };
}
