import { AsyncLocalStorage } from 'node:async_hooks';

import Express from 'express';

import { AsyncService, IContainer, Autoinject, Container } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';
import { DataValidator } from '@spinajs/validation';
import { Configuration } from '@spinajs/configuration';
import { IController, IControllerDescriptor, IActionLocalStoregeContext } from './interfaces.js';
import { CONTROLLED_DESCRIPTOR_SYMBOL } from './decorators.js';
import { RouteRegistrationException } from './exceptions.js';
import { __handle_response__ } from './response.js';
import { __handle_error__ } from './error.js';
import { buildRoutePath, resolveRouteMiddlewares, resolveRoutePolicies, createPolicyGate, createActionHandler, wrapMiddlewareAction, ControllerActionHost } from './route-builder.js';

export abstract class BaseController extends AsyncService implements IController {
  /**
   * Array index getter
   */
  [action: string]: any;

  protected _router!: Express.Router;

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
   * Base path for all controller routes eg. my/custom/path/
   *
   * It can be defined via `@BasePath` decorator, defaults to controller name without `Controller` part.
   */
  public get BasePath(): string {
    return this.Descriptor.BasePath ? this.Descriptor.BasePath : this.constructor.name.toLowerCase();
  }

  public async resolve() {
    await super.resolve();

    if (!this.Descriptor) {
      this._log.warn(`Controller ${this.constructor.name} does not have descriptor. If its abstract or base class ignore this message.`);
      return;
    }

    this._router = Express.Router();

    for (const [, route] of this.Descriptor.Routes) {
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

      this._log.trace(`Registering route ${route.Type.toUpperCase()} ${this.constructor.name}::${String(route.Method)} at ${path}`);

      const handlers: (Express.RequestHandler | Express.ErrorRequestHandler)[] = [
        createPolicyGate(policies, route, this, this._log),
        ...enabledMiddlewares.map((m) => wrapMiddlewareAction(m, m.onBefore.bind(m), route, this)),
        createActionHandler(this as ControllerActionHost, route, enabledMiddlewares, this._actionLocalStorage),
        ...enabledMiddlewares.map((m) => wrapMiddlewareAction(m, m.onAfter.bind(m), route, this)),
        __handle_response__(),
        __handle_error__(),
      ];

      (this._router as any)[route.InternalType as string](path, handlers);
    }
  }
}
