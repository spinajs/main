import { AsyncLocalStorage } from 'node:async_hooks';
import { isPromise, tryGetHash } from '@spinajs/util';
import { routeFullPath, withRoutePrefix } from '@spinajs/manifest';

import Express from 'express';

import _ from 'lodash';

import { DI, IContainer } from '@spinajs/di';
import { AuthenticationFailed, UnexpectedServerError } from '@spinajs/exceptions';
import { Log } from '@spinajs/log';
import { Configuration } from '@spinajs/configuration';
import { RouteArgs } from './route-args/index.js';
import { withDerivedValidators, type DerivedArgValidators } from './route-args/manifest-schema.js';
import { Request as sRequest, IController, IControllerDescriptor, IPolicyDescriptor, IPolicyGroup, RouteMiddleware, IRoute, IMiddlewareDescriptor, BasePolicy, ParameterType, IActionLocalStoregeContext, IOnErrorDescriptor, IRouteInvocation, Response } from './interfaces.js';
import { RouteRegistrationException } from './exceptions.js';
import { createOnErrorHandler, markStage, runErrorHandlers, stageOf } from './errors/on-error.js';
import { __handle_response__ } from './response.js';
import { errorReplyFactory } from './error.js';
import { createAroundHandler, recordRouteError, wrapsRoute } from './around.js';
import { answerEarly, answeredEarly, beginRoute, enterMiddleware, repliedInPlace, routeContextOf, setErrorReply } from './reply-pipeline.js';
import { routeChainName } from './route-index.js';
import type { ErrorReplier } from './reply-pipeline.js';

/**
 * Controller shape needed by the route wiring helpers: the IController
 * surface plus indexed access to action methods. Structural on purpose —
 * avoids importing BaseController and creating a module cycle.
 */
export type ControllerActionHost = IController & { [action: string]: any };

/**
 * Computes the final express path for a route: `/BasePath/Path`, falling back
 * to the method name when the route has no explicit path, with optional
 * global route prefix (`http.controllers.route.prefix`). The manifest's
 * `fullPath` uses the same `routeFullPath`.
 */
export function buildRoutePath(basePath: string, route: IRoute, globalPrefix?: string): string {
  return withRoutePrefix(globalPrefix, routeFullPath(basePath, route.Path, String(route.Method)));
}

/**
 * Resolves global ( `http.routes.middlewares` ) + controller-wise + route-wise middleware descriptors into instances.
 */
export function resolveRouteMiddlewares(descriptor: IControllerDescriptor, route: IRoute, container: IContainer, globals: readonly IMiddlewareDescriptor[] = []): Promise<RouteMiddleware[]> {
  const local = descriptor.Middlewares.concat(route.Middlewares || []);
  // A class also declared with @Middleware would run twice; that declaration and its options win.
  const notLocal = globals.filter((g) => !local.some((m) => m.Type === g.Type));
  return Promise.all<RouteMiddleware>(
    notLocal.concat(local).map((m: IMiddlewareDescriptor) => {
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
              log.trace({ policy: policyType, controller: controllerName, method: route.Method, path }, 'Policy ${policy} is used in controller ${controller}::${method} at path ${path}');
              return container.resolve<BasePolicy>(policyType, m.Options);
            }

            log.trace({ policy: m.Type.name, controller: controllerName, method: route.Method, path }, 'Policy ${policy} is used in controller ${controller}::${method} at path ${path}');
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
export function createPolicyGate(policies: IResolvedRoutePolicies, route: IRoute, controller: IController, log: Log, basePath: string = controller.BasePath): Express.RequestHandler {
  const routeName = `${controller.constructor.name}:${String(route.Method)} ${basePath}/${String(route.Path || route.Method)}`;

  return (req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
    // Runs even when a 'beforePolicy' middleware answered: a refusal replaces that answer (fail closed).
    markStage(res, 'policy');

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
                    log.trace({ route: routeName, policy: p.constructor.name }, 'Policy succeded for route ${route}, policy: ${policy}');
                  })
                  .catch((err) => {
                    log.trace({ error: err, route: routeName, policy: p.constructor.name }, 'Policy failed for route ${route}, policy: ${policy}');
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
          log.trace({ route: routeName }, 'Policy for route ${route} succeded, continue execution');
          next();
          return;
        }

        // Report a failure of the first scope that did not hold — reporting a
        // later scope's error would name a requirement the caller never got as
        // far as. Within it, a group that authenticated the caller and then
        // refused outranks one that found no credential: a session without the
        // grant must get the session group's 403, not the token group's
        // "access token required" 401, which clients read as a lost session.
        // Otherwise declaration order decides. Use next(err) directly (not
        // `throw next(...)`, which would reject this .then() with `undefined`
        // as an unhandled rejection while the error was already forwarded).
        const blocking = scopeResults.find((groups) => !groups.some((results) => results.every((r) => r.status === 'fulfilled')));
        const rejections = (blocking ?? []).flat().filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        const failed = rejections.find((r) => !(r.reason instanceof AuthenticationFailed)) ?? rejections[0];
        next(failed ? failed.reason : new UnexpectedServerError('Policy evaluation produced no result'));
      })
      // Guard against unexpected throws in the settle/handler chain so the
      // request can never stall without a response.
      .catch((err) => next(err));
  };
}

const contextOf = (req: Express.Request, res: Express.Response, route: IRoute, controller: IController, path: string): IRouteInvocation =>
  routeContextOf(res) ?? { req, res, storage: (req as sRequest).storage, route, controller, path: routeChainName(route, path) };

const isResponse = (value: unknown): value is Response => typeof (value as Response | null | undefined)?.execute === 'function';

const named = <T extends Express.RequestHandler>(handler: T, name: string): T => {
  Object.defineProperty(handler, 'name', { value: name, writable: true });
  return handler;
};

/**
 * Express handler running `middleware.onBefore`: a resolved one enters the middleware (unless its around handler
 * already did), a returned `Response` answers the request, a rejection goes to the error handlers.
 */
export function createBeforeHandler(middleware: RouteMiddleware, route: IRoute, controller: IController, path: string): Express.RequestHandler {
  const enters = !wrapsRoute(middleware);
  return named((req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
    if (answeredEarly(res)) {
      next();
      return;
    }
    markStage(res, 'middleware');
    const ctx = contextOf(req, res, route, controller, path);
    Promise.resolve(middleware.onBefore!(ctx))
      .then((answer) => {
        if (enters) {
          enterMiddleware(res, 'route', middleware, ctx);
        }
        if (answer === undefined || answer === null) {
          next();
        } else if (!isResponse(answer)) {
          next(new UnexpectedServerError(`${middleware.constructor.name}.onBefore returned something that is not a Response`));
        } else {
          answerEarly(res, answer);
          next();
        }
      })
      .catch((err: unknown) => {
        next(err);
      });
  }, middleware.constructor.name);
}

/** Enters a middleware that has only `onAfter`/`onFinish` once the chain reaches it. */
export function createEntryHandler(middleware: RouteMiddleware, route: IRoute, controller: IController, path: string): Express.RequestHandler {
  return named((req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
    if (!answeredEarly(res)) {
      enterMiddleware(res, 'route', middleware, contextOf(req, res, route, controller, path));
    }
    next();
  }, middleware.constructor.name);
}

/**
 * Express handler invoking the controller action: extracts route arguments, runs the action inside the request-scoped
 * AsyncLocalStorage context and stores its result in `res.locals.response` for the route's sender. All sync and async
 * errors are forwarded to `next`. Skipped when an `onBefore` answered.
 */
export function createActionHandler(controller: ControllerActionHost, route: IRoute, storage: AsyncLocalStorage<IActionLocalStoregeContext>, derived?: DerivedArgValidators): Express.RequestHandler {
  const actionHandler = async (req: sRequest, res: Express.Response, next: Express.NextFunction) => {
    if (answeredEarly(res)) {
      next();
      return;
    }
    try {
      await storage.run(req.storage, async () => {
        markStage(res, 'arguments');
        const args = (await extractRouteArgs(route, req, res, controller.constructor.name, derived)).concat([req, res, next]);

        let result: unknown;

        try {
          markStage(res, 'action');
          result = controller[route.Method as string].call(controller, ...args);

          if (isPromise(result)) {
            result = await result;
          }
        } catch (err) {
          next(err);
          return;
        }

        res.locals.response = result;
        next();
      });
    } catch (err) {
      next(err);
    }
  };

  return named(actionHandler as Express.RequestHandler, controller.constructor.name);
}

export interface IRouteChainOptions {
  controller: ControllerActionHost;
  route: IRoute;
  /** The mounted express path. */
  path: string;
  basePath: string;
  /** Every resolved middleware of the route, enabled or not. */
  middlewares: RouteMiddleware[];
  policies: IResolvedRoutePolicies;
  errorHandlers: readonly IOnErrorDescriptor[];
  storage: AsyncLocalStorage<IActionLocalStoregeContext>;
  derived?: DerivedArgValidators;
  container: IContainer;
  log: Log;
  handleError: Express.ErrorRequestHandler;
}

/**
 * A 3.x `onResponse` left on a middleware compiles (it is just another method) but is never called: a redaction or
 * envelope middleware would serve the reply unchanged without a word.
 */
function refuseOnResponse(middlewares: readonly RouteMiddleware[], route: string): void {
  const legacy = middlewares.find((m) => typeof (m as { onResponse?: unknown }).onResponse === 'function');
  if (legacy) {
    throw new RouteRegistrationException(
      `Middleware ${legacy.constructor.name} of route ${route} defines onResponse, removed in @spinajs/http 4.0: implement onAfter(ctx) instead, with the reply in ctx.response and the error it answers in ctx.error`,
    );
  }
}

/**
 * Calls `onRegister` of the enabled middlewares, then assembles the route's handler chain:
 *
 * route entry → each 'beforePolicy' middleware (its around handler, then onBefore) → policy gate → each 'outer' one,
 * the same way → each 'inner' one → action → [error recorder] → error handlers → response → [error recorder] → __handle_error__
 *
 * The response and __handle_error__ send their reply through the reply pipeline, which runs the onAfter hooks of the
 * entered middlewares. The recorders are mounted only when a middleware has `onAround`; they give its `proceed()` the
 * chain's error.
 */
export async function buildRouteHandlers(options: IRouteChainOptions): Promise<(Express.RequestHandler | Express.ErrorRequestHandler)[]> {
  const { controller, route, log } = options;
  const name = routeChainName(route, options.path);
  refuseOnResponse(options.middlewares, name);
  const enabled = options.middlewares.filter((m) => m.isEnabled(route, controller));

  for (const m of enabled) {
    if (!m.onRegister) {
      continue;
    }
    try {
      await m.onRegister(route, options.path, controller);
    } catch (err) {
      throw new RouteRegistrationException(`Middleware ${m.constructor.name} refused the registration of route ${name}: ${(err as Error)?.message ?? String(err)}`, err);
    }
  }

  const beforePolicy = enabled.filter((m) => m.Stage === 'beforePolicy');
  const outer = enabled.filter((m) => m.Stage === 'outer');
  const inner = enabled.filter((m) => m.Stage !== 'outer' && m.Stage !== 'beforePolicy');
  const recorder = enabled.some(wrapsRoute) ? [recordRouteError] : [];
  let mappedReply: ReturnType<typeof errorReplyFactory> | undefined;

  // D8: the reply a throwing onAfter turns into, made as for an error of the action, at the 'after' stage
  const routeErrorReply =
    (req: Express.Request, res: Express.Response): ErrorReplier =>
    async (err) => {
      const handled = await runErrorHandlers(options.errorHandlers, err, { req: req as sRequest, res, route, controller, stage: stageOf(res), container: options.container }, log);
      if (handled.response) {
        return { response: handled.response, error: handled.error };
      }
      mappedReply ??= errorReplyFactory();
      return { response: mappedReply(handled.error, req).response, error: handled.error };
    };

  const contract = { controller: controller.constructor.name, handler: String(route.Method) };
  const entry: Express.RequestHandler = (req, res, next) => {
    // answered in place before routing (a deadline during a slow server onBefore): no part of the route runs
    if (repliedInPlace(res)) {
      return;
    }
    beginRoute(res, {
      context: { req, res, storage: (req as sRequest).storage, route, controller, path: name },
      container: options.container,
      contract,
      storage: options.storage,
      errorReply: routeErrorReply(req, res),
    });
    next();
  };

  const middlewareHandlers = (stage: RouteMiddleware[]) =>
    stage.flatMap((m) => [
      ...(wrapsRoute(m) ? [createAroundHandler(m, route, controller, name, log)] : []),
      ...(m.onBefore ? [createBeforeHandler(m, route, controller, options.path)] : []),
      ...(!wrapsRoute(m) && !m.onBefore && (m.onAfter || m.onFinish) ? [createEntryHandler(m, route, controller, options.path)] : []),
    ]);

  return [
    entry,
    ...middlewareHandlers(beforePolicy),
    createPolicyGate(options.policies, route, controller, log, options.basePath),
    ...middlewareHandlers([...outer, ...inner]),
    createActionHandler(controller, route, options.storage, options.derived),
    ...recorder,
    createOnErrorHandler(options.errorHandlers, route, controller, options.container, log, setErrorReply),
    __handle_response__(options.container),
    ...recorder,
    options.handleError,
  ];
}

/**
 * Extracts route argument values for an action call. Route-arg handlers are
 * resolved from DI by parameter type and executed in Priority order
 * (higher first). `derived` holds the manifest-derived schema checks of the route's arguments.
 */
export function extractRouteArgs(route: IRoute, req: sRequest, res: Express.Response, controllerName: string, derived?: DerivedArgValidators): Promise<any[]> {
  return withDerivedValidators(derived, () => extractArgs(route, req, res, controllerName));
}

async function extractArgs(route: IRoute, req: sRequest, res: Express.Response, controllerName: string): Promise<any[]> {
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
