import { AsyncLocalStorage } from 'node:async_hooks';
import { isPromise, tryGetHash } from '@spinajs/util';

import Express from 'express';

import _ from 'lodash';

import { DI, IContainer } from '@spinajs/di';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { Log } from '@spinajs/log';
import { Configuration } from '@spinajs/configuration';
import { RouteArgs } from './route-args/index.js';
import { Request as sRequest, Response, IController, IControllerDescriptor, IPolicyDescriptor, IPolicyGroup, RouteMiddleware, IRoute, IMiddlewareDescriptor, BasePolicy, ParameterType, IActionLocalStoregeContext } from './interfaces.js';
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
 * Policy instances for one route, kept split by the scope they were declared
 * at. The two scopes are combined with AND by {@link createPolicyGate}, so a
 * controller-wide policy cannot be satisfied *instead of* a route's own.
 */
export interface IResolvedRoutePolicies {
  /** Groups declared on the controller class. */
  Controller: BasePolicy[][];

  /** Groups declared on the route method. */
  Route: BasePolicy[][];
}

/**
 * Resolves controller-wise + route-wise policy descriptors into instances,
 * keeping both the grouping produced by `@Policy()` ( one inner array per
 * decorator call, combined with AND ) and the scope each group was declared
 * at ( the two scopes are combined with AND ).
 *
 * String policy descriptors are configuration keys pointing at a policy type
 * name. A key that does not resolve to a registered BasePolicy type throws
 * {@link RouteRegistrationException} — a silently dropped policy would leave
 * the route unprotected.
 */
export async function resolveRoutePolicies(
  descriptor: IControllerDescriptor,
  route: IRoute,
  container: IContainer,
  cfg: Configuration,
  log: Log,
  controllerName: string,
  path: string,
): Promise<IResolvedRoutePolicies> {
  const resolveGroups = (groups: IPolicyGroup[]) =>
    Promise.all<BasePolicy[]>(
      groups.map((group: IPolicyGroup) =>
        Promise.all<BasePolicy>(
          group.map((m: IPolicyDescriptor) => {
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
        ),
      ),
    );

  const [controllerPolicies, routePolicies] = await Promise.all([resolveGroups(descriptor.Policies), resolveGroups(route.Policies || [])]);

  return { Controller: controllerPolicies, Route: routePolicies };
}

/**
 * Express handler gating a route behind its policies.
 *
 * Three levels combine, from the inside out:
 *
 *  - a GROUP is one `@Policy()` call. All of its members must resolve ( AND ),
 *    which is how one access path demands several conditions at once, e.g. an
 *    authorized session AND a feature switch.
 *  - a SCOPE is all the groups declared at one place, on the controller class
 *    or on the route method. Any one of its groups passing is enough ( OR ),
 *    which is how a resource offers several independent access paths, e.g.
 *    api token OR session.
 *  - the two scopes are combined with AND. A controller-wide policy states
 *    what every route needs, so it can only ever NARROW a route - it must not
 *    be satisfiable *instead of* the route's own policies.
 *
 * A scope with no enabled group states no requirement and passes, so a route
 * that nothing guards still runs.
 */
export function createPolicyGate(policies: IResolvedRoutePolicies, route: IRoute, controller: IController, log: Log): Express.RequestHandler {
  const routeName = `${controller.constructor.name}:${String(route.Method)} ${controller.BasePath}/${String(route.Path || route.Method)}`;

  return (req: Express.Request, _res: Express.Response, next: Express.NextFunction) => {
    // Only policies enabled for this concrete route participate in the gate.
    //
    // A group left with no enabled member is DROPPED, not treated as passing:
    // an empty AND is vacuously true, and one vacuously true group would open
    // its whole scope for every caller, including when a sibling group in that
    // scope is a live authorization check.
    const enable = (groups: BasePolicy[][]) => groups.map((group) => group.filter((p) => p.isEnabled(route, controller))).filter((group) => group.length > 0);

    const scopes = [enable(policies.Controller), enable(policies.Route)].filter((scope) => scope.length > 0);

    if (scopes.length === 0) {
      next();
      return;
    }

    Promise.all(
      // allSettled per group: a rejecting member must not escape as an
      // unhandled rejection while a sibling group is still deciding, and the
      // outer Promise.all must never reject on its own.
      scopes.map((scope) =>
        Promise.all(
          scope.map((group) =>
            Promise.allSettled(
              group.map((p) => {
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
            ),
          ),
        ),
      ),
    )
      .then((scopeResults) => {
        // AND across scopes, OR across the groups of one scope, AND inside a
        // group.
        if (scopeResults.every((groups) => groups.some((results) => results.every((r) => r.status === 'fulfilled')))) {
          log.trace(`Policy for route ${routeName} succeded, continue execution`);
          next();
          return;
        }

        // Report the first failure of the first scope that did not hold, in
        // declaration order — reporting a later scope's error would name a
        // requirement the caller never got as far as. Use next(err) directly
        // (not `throw next(...)`, which would reject this .then() with
        // `undefined` as an unhandled rejection while the error was already
        // forwarded).
        const blocking = scopeResults.find((groups) => !groups.some((results) => results.every((r) => r.status === 'fulfilled')));
        const failed = (blocking ?? []).flat().find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
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
