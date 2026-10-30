import { AsyncLocalStorage } from 'node:async_hooks';

import Express from 'express';

import { AsyncService, IContainer, Autoinject, Container } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';
import { DataValidator } from '@spinajs/validation';
import { Configuration } from '@spinajs/configuration';
import { configuredMountPath, controllerMountPath } from '@spinajs/manifest';
import { IController, IControllerDescriptor, IActionLocalStoregeContext, IRoute } from './interfaces.js';
import { CONTROLLED_DESCRIPTOR_SYMBOL } from './decorators.js';
import { RouteRegistrationException } from './exceptions.js';
import { __handle_response__ } from './response.js';
import { __handle_error__ } from './error.js';
import { createOnErrorHandler, resolveConfigErrorHandlers } from './errors/on-error.js';
import { classLineage, derivedValidatorsOf } from './route-args/manifest-schema.js';
import { routesWithRuntimeTypes } from './manifest-runtime-types.js';
import { buildRoutePath, resolveRouteMiddlewares, resolveRoutePolicies, createPolicyGate, createActionHandler, wrapMiddlewareAction, ControllerActionHost } from './route-builder.js';

export abstract class BaseController extends AsyncService implements IController {
  /**
   * Array index getter
   */
  [action: string]: any;

  protected _router!: Express.Router;

  private _routes?: Map<string | symbol, IRoute>;

  @Autoinject(Container)
  protected _container!: IContainer;

  @Autoinject()
  protected _validator!: DataValidator;

  @Logger('http')
  protected _log!: Log;

  @Autoinject()
  protected _actionLocalStorage!: AsyncLocalStorage<IActionLocalStoregeContext>;

  @Autoinject(Configuration)
  protected _cfg!: Configuration;

  /**
   * Express router with middleware stack
   */
  public get Router(): Express.Router {
    return this._router;
  }

  /**
   * Controller descriptor
   */
  public get Descriptor(): IControllerDescriptor {
    return Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, this) as IControllerDescriptor;
  }

  /**
   * The routes this instance serves. The descriptor is shared by every boot in the process; in a build without
   * decorator metadata a route's argument types are filled on a copy held here.
   */
  public get Routes(): Map<string | symbol, IRoute> {
    return this._routes ?? this.Descriptor.Routes;
  }

  /**
   * Base path for all controller routes eg. my/custom/path/
   *
   * It can be defined via `@BasePath` decorator, defaults to the lower-cased class name ( `UsersController` → `userscontroller` ).
   * `@BasePath({ config, default })` reads the path from configuration on every call.
   */
  public get BasePath(): string {
    const { BasePath, BasePathConfig } = this.Descriptor;

    if (BasePathConfig) {
      const configured = this._cfg.get<unknown>(BasePathConfig, BasePath);
      if (typeof configured !== 'string' || configured.trim() === '') {
        throw new RouteRegistrationException(`Configuration key ${BasePathConfig} of ${this.constructor.name} must be a non-empty path string`);
      }
      return configuredMountPath(configured);
    }

    return controllerMountPath(BasePath, this.constructor.name);
  }

  public async resolve() {
    await super.resolve();

    if (!this.Descriptor) {
      this._log.warn({ controller: this.constructor.name }, 'Controller ${controller} does not have descriptor. If its abstract or base class ignore this message.');
      return;
    }

    this._router = Express.Router();

    const configErrorHandlers = await resolveConfigErrorHandlers(this._cfg, this._container);
    const controller = this.constructor.name;
    const lineage = classLineage(this.constructor);
    this._routes = await routesWithRuntimeTypes({ container: this._container, controller, lineage, routes: this.Descriptor.Routes, mountPath: () => this.BasePath, log: this._log });

    for (const [, route] of this._routes) {
      // Fail fast: an unknown route type means the route decorator never set a
      // valid express method — mounting the rest of the controller while
      // silently dropping this route would hide the bug.
      if (route.InternalType === 'unknown') {
        throw new RouteRegistrationException(`Unknown route type for ${this.constructor.name}::${String(route.Method)}`);
      }

      const path = buildRoutePath(this.BasePath, route, this._cfg.get('http.controllers.route.prefix'));

      const middlewares = await resolveRouteMiddlewares(this.Descriptor, route, this._container);
      const policies = await resolveRoutePolicies(this.Descriptor, route, this._container, this._cfg, this._log, this.constructor.name, path);
      const enabledMiddlewares = middlewares.filter((m) => m.isEnabled(route, this));

      this._log.trace({ httpMethod: route.Type.toUpperCase(), controller: this.constructor.name, method: route.Method, path }, 'Registering route ${httpMethod} ${controller}::${method} at ${path}');

      const errorHandlers = [...(route.ErrorHandlers ?? []), ...(this.Descriptor.ErrorHandlers ?? []), ...configErrorHandlers];
      const derived = derivedValidatorsOf({ container: this._container, controller, lineage, route, mountPath: this.BasePath, log: this._log });

      const handlers: (Express.RequestHandler | Express.ErrorRequestHandler)[] = [
        createPolicyGate(policies, route, this, this._log),
        ...enabledMiddlewares.map((m) => wrapMiddlewareAction(m, m.onBefore.bind(m), route, this, 'middleware')),
        createActionHandler(this as ControllerActionHost, route, enabledMiddlewares, this._actionLocalStorage, derived),
        ...enabledMiddlewares.map((m) => wrapMiddlewareAction(m, m.onAfter.bind(m), route, this, 'after')),
        createOnErrorHandler(errorHandlers, route, this, this._container, this._log),
        __handle_response__(this._container, { controller: this.constructor.name, handler: String(route.Method) }),
        __handle_error__(this._container),
      ];

      (this._router as any)[route.InternalType as string](path, handlers);
    }
  }
}
