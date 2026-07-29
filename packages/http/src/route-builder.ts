import { AsyncLocalStorage } from 'node:async_hooks';
import { isPromise, tryGetHash } from '@spinajs/util';

import Express from 'express';

import _ from 'lodash';

import { DI, IContainer } from '@spinajs/di';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { Log } from '@spinajs/log';
import { Configuration } from '@spinajs/configuration';
import { RouteArgs } from './route-args/index.js';
import { Request as sRequest, Response, IController, IControllerDescriptor, IPolicyDescriptor, RouteMiddleware, IRoute, IMiddlewareDescriptor, BasePolicy, ParameterType, IActionLocalStoregeContext } from './interfaces.js';
import { RouteRegistrationException } from './exceptions.js';

/**
 * Controller shape needed by the route wiring helpers: the IController
 * surface plus indexed access to action methods. Structural on purpose —
 * avoids importing BaseController and creating a module cycle.
 */
export type ControllerActionHost = IController & { [action: string]: any };

/**
 * Computes the final express path for a route: `/BasePath/Path`, falling back
 * to the method name when the route has no explicit path, with optional
 * global route prefix (`http.controllers.route.prefix`).
 */
export function buildRoutePath(basePath: string, route: IRoute, globalPrefix?: string): string {
  let path = '';
  if (route.Path) {
    if (route.Path === '/') {
      path = `/${basePath}`;
    } else if (basePath === '/') {
      path = `/${route.Path}`;
    } else {
      path = `/${basePath}/${route.Path}`;
    }
  } else {
    path = `/${basePath}/${String(route.Method)}`;
  }

  if (globalPrefix) {
    path = `/${globalPrefix}${path}`;
  }

  return path;
}

/**
 * Resolves controller-wise + route-wise middleware descriptors into instances.
 */
export function resolveRouteMiddlewares(descriptor: IControllerDescriptor, route: IRoute, container: IContainer): Promise<RouteMiddleware[]> {
  return Promise.all<RouteMiddleware>(
    descriptor.Middlewares.concat(route.Middlewares || []).map((m: IMiddlewareDescriptor) => {
      return container.resolve(m.Type, m.Options);
    }),
  );
}

/**
 * Resolves controller-wise + route-wise policy descriptors into instances.
 *
 * String policy descriptors are configuration keys pointing at a policy type
 * name. A key that does not resolve to a registered BasePolicy type throws
 * {@link RouteRegistrationException} — a silently dropped policy would leave
 * the route unprotected.
 */
export function resolveRoutePolicies(
  descriptor: IControllerDescriptor,
  route: IRoute,
  container: IContainer,
  cfg: Configuration,
  log: Log,
  controllerName: string,
  path: string,
): Promise<BasePolicy[]> {
  return Promise.all<BasePolicy>(
    descriptor.Policies.concat(route.Policies || []).map((m: IPolicyDescriptor) => {
      if (_.isString(m.Type)) {
        const policyType = cfg.get<string>(m.Type);
        if (!policyType || !DI.checkType(BasePolicy, policyType)) {
          throw new RouteRegistrationException(
            `No policy named ${policyType ?? '<undefined>'} is registered for route ${controllerName}::${String(route.Method)} at path ${path} ( check your configuration at ${m.Type} )`,
          );
        }
        log.trace(`Policy ${policyType} is used in controller ${controllerName}::${String(route.Method)} at path ${path}`);
        return container.resolve<BasePolicy>(policyType, m.Options);
      }

      log.trace(`Policy ${m.Type.name} is used in controller ${controllerName}::${String(route.Method)} at path ${path}`);
      return container.resolve<BasePolicy>(m.Type, m.Options);
    }),
  );
}

/**
 * Express handler gating a route behind its policies.
 *
 * Executes all policies enabled for the route; if at least ONE policy resolves
 * without error the route is allowed to execute. This allows multiple access
 * paths to a resource, e.g. token access & session.
 */
export function createPolicyGate(policies: BasePolicy[], route: IRoute, controller: IController, log: Log): Express.RequestHandler {
  const routeName = `${controller.constructor.name}:${String(route.Method)} ${controller.BasePath}/${String(route.Path || route.Method)}`;

  return (req: Express.Request, _res: Express.Response, next: Express.NextFunction) => {
    // Only policies enabled for this concrete route participate in the gate.
    // A route whose policies are ALL disabled has no active authorization
    // check, so it is allowed through — same semantics as having no policies
    // at all. Computing this up front is what prevents the request from
    // hanging: `Promise.allSettled([])` resolves to `[]`, which matches
    // neither the fulfilled nor the rejected branch below, so `next` would
    // never be called.
    const enabledPolicies = policies.filter((p) => p.isEnabled(route, controller));
    if (enabledPolicies.length === 0) {
      next();
      return;
    }

    Promise.allSettled(
      enabledPolicies.map((p) => {
        return p
          .execute(req, route, controller)
          .then(() => {
            log.trace(`Policy succeded for route ${routeName}, policy: ${p.constructor.name}`);
          })
          .catch((err) => {
            log.trace(`Policy failed for route ${routeName} error ${err}, policy: ${p.constructor.name}`);
            throw err;
          });
      }),
    )
      .then((results) => {
        const fullfilled = results.find((r) => r.status === 'fulfilled');
        if (fullfilled) {
          log.trace(`Policy for route ${routeName} succeded, continue execution`);
          next();
          return;
        }

        // Every policy rejected — forward the first failure to the express
        // error handler. Use next(err) directly (not `throw next(...)`,
        // which would reject this .then() with `undefined` as an unhandled
        // rejection while the error was already forwarded).
        const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
        next(failed ? failed.reason : new UnexpectedServerError('Policy evaluation produced no result'));
      })
      // Guard against unexpected throws in the settle/handler chain so the
      // request can never stall without a response.
      .catch((err) => next(err));
  };
}

/**
 * Wraps a middleware onBefore/onAfter action into an express handler that
 * forwards both resolution and rejection to `next`.
 */
export function wrapMiddlewareAction(
  source: object,
  action: (req: Express.Request, res: Express.Response, route: IRoute, controller: IController) => Promise<void>,
  route: IRoute,
  controller: IController,
): Express.RequestHandler {
  const wrapper = (req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
    action(req, res, route, controller)
      .then(() => {
        next();
      })
      .catch((err: any) => {
        next(err);
      });
  };

  Object.defineProperty(wrapper, 'name', {
    value: source.constructor.name,
    writable: true,
  });
  return wrapper;
}

/**
 * Express handler invoking the controller action: extracts route arguments,
 * runs the action inside the request-scoped AsyncLocalStorage context, lets
 * middlewares inspect the produced Response and stores it in
 * `res.locals.response` for the response pipeline. All sync and async errors
 * are forwarded to `next`.
 */
export function createActionHandler(
  controller: ControllerActionHost,
  route: IRoute,
  enabledMiddlewares: RouteMiddleware[],
  storage: AsyncLocalStorage<IActionLocalStoregeContext>,
): Express.RequestHandler {
  const actionHandler = async (req: sRequest, res: Express.Response, next: Express.NextFunction) => {
    try {
      await storage.run(req.storage, async () => {
        const args = (await extractRouteArgs(route, req, res, controller.constructor.name)).concat([req, res, next]);

        try {
          const result = controller[route.Method as string].call(controller, ...args);

          if (isPromise(result)) {
            result
              .then((r: unknown) => {
                if (r instanceof Response) {
                  enabledMiddlewares.forEach((x) => x.onResponse(r, route, controller));
                }
                res.locals.response = r;
                next();
              })
              .catch((err: unknown) => {
                next(err);
              });
          } else {
            if (result instanceof Response) {
              enabledMiddlewares.forEach((x) => x.onResponse(result, route, controller));
            }
            res.locals.response = result;
            next();
          }
        } catch (err) {
          next(err);
        }
      });
    } catch (err) {
      next(err);
    }
  };

  Object.defineProperty(actionHandler, 'name', {
    value: controller.constructor.name,
    writable: true,
  });

  return actionHandler as Express.RequestHandler;
}

/**
 * Extracts route argument values for an action call. Route-arg handlers are
 * resolved from DI by parameter type and executed in Priority order
 * (higher first).
 */
export async function extractRouteArgs(route: IRoute, req: sRequest, res: Express.Response, controllerName: string): Promise<any[]> {
  const callArgs = new Array(route.Parameters.size);
  const argsCache = new Map<ParameterType | string, RouteArgs>();

  let callData = {
    Payload: {},
  };

  // Sort parameters by priority (higher priority first)
  // Get all parameters as array, resolve their handlers to check priority, then sort
  const paramsWithPriority = await Promise.all(
    Array.from(route.Parameters.values()).map(async (param) => {
      const handler = await tryGetHash(argsCache, param.Type, () => DI.resolve(param.Type));
      return { param, handler, priority: handler?.Priority ?? 0 };
    }),
  );

  // Sort by priority descending (higher priority first)
  const sortedParams = paramsWithPriority.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  for (const { param, handler: routeArgsHandler } of sortedParams) {
    if (!routeArgsHandler) {
      throw new UnexpectedServerError(`Route parameter not registered for parameter: ${param.Name},
            in method: ${String(route.Method)},
            in controller: ${controllerName}. Check if you have registered it in DI container.`);
    }

    const { Args, CallData } = await routeArgsHandler.extract(callData, callArgs, param, req, res, route);

    callData = CallData;
    callArgs[param.Index] = Args;
  }

  return callArgs;
}
