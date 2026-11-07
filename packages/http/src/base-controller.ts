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
import { __handle_error__ } from './error.js';
import { resolveConfigErrorHandlers } from './errors/on-error.js';
import { globalRouteMiddlewareDescriptors } from './global-route-middlewares.js';
import { classLineage, derivedValidatorsOf } from './route-args/manifest-schema.js';
import { routesWithRuntimeTypes } from './manifest-runtime-types.js';
import { buildRoutePath, buildRouteHandlers, resolveRouteMiddlewares, resolveRoutePolicies, ControllerActionHost } from './route-builder.js';
import { RouteIndex } from './route-index.js';

// Own metadata only: an undecorated class would report the file of the base whose descriptor it reads.
const ownSourceFile = (type: object): string | undefined => (Reflect.getOwnMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, (type as { prototype: object }).prototype) as IControllerDescriptor | undefined)?.SourceFile;

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

  // Optional: a controller built with `new` (a unit test) has no container to inject it.
  @Autoinject(RouteIndex)
  protected _routeIndex?: RouteIndex;

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

    const descriptor = this.Descriptor;
    if (!descriptor) {
      this._log.warn({ controller: this.constructor.name }, 'Controller ${controller} does not have descriptor. If its abstract or base class ignore this message.');
      return;
    }

    this._router = Express.Router();
    this._routeIndex?.remove(this);

    const configErrorHandlers = await resolveConfigErrorHandlers(this._cfg, this._container);
    const globalMiddlewares = globalRouteMiddlewareDescriptors(this._cfg, this._container);
    const controller = this.constructor.name;
    const lineage = classLineage(this.constructor, ownSourceFile);
    this._routes = await routesWithRuntimeTypes({ container: this._container, controller, lineage, routes: descriptor.Routes, mountPath: () => this.BasePath, log: this._log });

    const prefix = this._cfg.get<string>('http.controllers.route.prefix');
    // Read at the first route: a controller with no routes never reads its configured path, and an unknown route type still fails first.
    let basePath: string | undefined;
    let handleError: Express.ErrorRequestHandler | undefined;

    for (const [, route] of this._routes) {
      // Fail fast: an unknown route type means the route decorator never set a
      // valid express method — mounting the rest of the controller while
      // silently dropping this route would hide the bug.
      if (route.InternalType === 'unknown') {
        throw new RouteRegistrationException(`Unknown route type for ${controller}::${String(route.Method)}`);
      }

      basePath ??= this.BasePath;
      const path = buildRoutePath(basePath, route, prefix);

      const middlewares = await resolveRouteMiddlewares(descriptor, route, this._container, globalMiddlewares);
      const policies = await resolveRoutePolicies(descriptor, route, this._container, this._cfg, this._log, controller, path);

      this._log.trace({ httpMethod: route.Type.toUpperCase(), controller, method: route.Method, path }, 'Registering route ${httpMethod} ${controller}::${method} at ${path}');

      const errorHandlers = [...(route.ErrorHandlers ?? []), ...(descriptor.ErrorHandlers ?? []), ...configErrorHandlers];
      const derived = derivedValidatorsOf({ container: this._container, controller, lineage, route, mountPath: basePath, log: this._log });

      const handlers = await buildRouteHandlers({
        controller: this as ControllerActionHost,
        route,
        path,
        basePath,
        middlewares,
        policies,
        errorHandlers,
        storage: this._actionLocalStorage,
        derived,
        container: this._container,
        log: this._log,
        handleError: (handleError ??= __handle_error__(this._container)),
      });

      (this._router as any)[route.InternalType as string](path, handlers);
      this._routeIndex?.add(this, route, path);
    }
  }
}
