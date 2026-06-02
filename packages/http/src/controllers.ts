import { AsyncLocalStorage } from 'node:async_hooks';
import { isPromise } from 'node:util/types';

import Express from 'express';

import _ from 'lodash';

import { AsyncService, IContainer, Autoinject, DI, ClassInfo, Container, Class } from '@spinajs/di';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { ListFromFiles } from '@spinajs/reflection';
import { Logger, Log } from '@spinajs/log';
import { DataValidator } from '@spinajs/validation';
import { Configuration } from '@spinajs/configuration';
import { HttpServer } from './server.js';
import { RouteArgs } from './route-args/index.js';
import { Request as sRequest, Response, IController, IControllerDescriptor, IPolicyDescriptor, RouteMiddleware, IRoute, IMiddlewareDescriptor, BasePolicy, ParameterType, IActionLocalStoregeContext, Request } from './interfaces.js';
import { CONTROLLED_DESCRIPTOR_SYMBOL } from './decorators.js';
import { tryGetHash } from '@spinajs/util';
import { DefaultControllerCache } from './cache.js';
import { __handle_response__ } from './response.js';
import { __handle_error__ } from './error.js';



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

    const self = this;

    

    if (!this.Descriptor) {
      this._log.warn(`Controller ${this.constructor.name} does not have descriptor. It its abstract or base class ignore this message.`);
      return;
    }

    this._router = Express.Router();

    for (const [, route] of this.Descriptor.Routes) {
      const handlers: (Express.RequestHandler | Express.ErrorRequestHandler)[] = [];

      let path = '';
      if (route.Path) {
        if (route.Path === '/') {
          path = `/${this.BasePath}`;
        } else {
          if (this.BasePath === '/') {
            path = `/${route.Path}`;
          } else {
            path = `/${this.BasePath}/${route.Path}`;
          }
        }
      } else {
        path = `/${this.BasePath}/${String(route.Method)}`;
      }

      // add global route path prefix
      if (this._cfg.get('http.controllers.route.prefix')) {
        path = `/${this._cfg.get('http.controllers.route.prefix')}${path}`;
      }

      const middlewares = await Promise.all<RouteMiddleware>(
        this.Descriptor.Middlewares.concat(route.Middlewares || []).map((m: IMiddlewareDescriptor) => {
          return self._container.resolve(m.Type, m.Options);
        }),
      );
      const policies = await Promise.all<BasePolicy>(
        this.Descriptor.Policies.concat(route.Policies || [])
          .map((m: IPolicyDescriptor) => {
            if (_.isString(m.Type)) {
              const policyType = this._cfg.get<string>(m.Type);
              if (!DI.checkType(BasePolicy, policyType)) {
                self._log.warn(`No policy named ${policyType} is registered ( check your configuration at ${m.Type})`);
                return null;
              } else {
                self._log.trace(`Policy ${policyType} is used in controller ${self.constructor.name}::${String(route.Method)} at path ${path}`);
                return self._container.resolve<BasePolicy>(policyType, m.Options);
              }
            } else {
              self._log.trace(`Policy ${m.Type.name} is used in controller ${self.constructor.name}::${String(route.Method)} at path ${path}`);
              return self._container.resolve<BasePolicy>(m.Type, m.Options);
            }
          })
          .filter((x) => x !== null),
      );
      const enabledMiddlewares = middlewares.filter((m) => m.isEnabled(route, this));

      this._log.trace(`Registering route ${route.Type.toUpperCase()} ${this.constructor.name}::${String(route.Method)} at ${path}`);

      // Execute all policies for route
      // If at least ONE policy returns no error allow route to execute
      // It allows to use multiple access to resource eg. token access & session
      handlers.push((req: Express.Request, _res: Express.Response, next: Express.NextFunction) => {
        if (policies.length === 0) {
          next();
          return;
        }

        Promise.allSettled(policies
          .filter((p) => p.isEnabled(route, this))
          .map((p) => {
            return p
              .execute(req, route, this)
              .then(() => {
                this._log.trace(`Policy succeded for route ${self.constructor.name}:${String(route.Method)} ${self.BasePath}/${String(route.Path || route.Method)}, policy: ${p.constructor.name}`);
              })
              .catch((err) => {
                this._log.trace(`Policy failed for route ${self.constructor.name}:${String(route.Method)} ${self.BasePath}/${String(route.Path || route.Method)} error ${err}, policy: ${p.constructor.name}`);
                throw err;
              });
          })).then((results) => {
            const fullfilled = results.find(r => r.status === 'fulfilled');
            if (fullfilled) {
              this._log.trace(`Policy for route ${self.constructor.name}:${String(route.Method)} ${self.BasePath}/${String(route.Path || route.Method)} succeded, continue execution`);
              next();
              return;
            }

            const failed = results.find(r => r.status === 'rejected');
            if (failed && "reason" in failed) {
              throw next(failed.reason);
            }
          })
      });
      handlers.push(...enabledMiddlewares.map((m) => _invokeAction(m, m.onBefore.bind(m), route)));

      const acionWrapper = async (req: sRequest, res: Express.Response, next: Express.NextFunction) => {
        try {
          await this._actionLocalStorage.run(req.storage, async () => {
            const args = (await _extractRouteArgs(route, req, res)).concat([req, res, next]);

            try {
              const result = (this as any)[route.Method].call(this, ...args);

              if (isPromise(result)) {
                result
                  .then((r) => {
                    if (r instanceof Response) {
                      enabledMiddlewares.forEach((x) => x.onResponse(r, route, this));
                    }
                    res.locals.response = r;
                    next();
                  })
                  .catch((err) => {
                    next(err);
                  });
              } else {
                if (result instanceof Response) {
                  enabledMiddlewares.forEach((x) => x.onResponse(result, route, this));
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

      Object.defineProperty(acionWrapper, 'name', {
        value: this.constructor.name,
        writable: true,
      });

      handlers.push(acionWrapper);
      handlers.push(...enabledMiddlewares.map((m) => _invokeAction(m, m.onAfter.bind(m), route)));

      // register to express router
      if (route.InternalType === 'unknown') {
        this._log.warn(`Unknown route type for ${this.constructor.name}::${String(route.Method)} at path ${path}`);
        return;
      }

      handlers.push(__handle_response__());
      handlers.push(__handle_error__());

      (this._router as any)[route.InternalType as string](path, handlers);
    }

    function _invokeAction(source: any, action: any, route: IRoute) {
      const wrapper = (req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
        action(req, res, route, self)
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

    async function _extractRouteArgs(route: IRoute, req: Request, res: Express.Response) {
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
        })
      );

      // Sort by priority descending (higher priority first)
      const sortedParams = paramsWithPriority.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

      for (const { param, handler: routeArgsHandler } of sortedParams) {
        if (!routeArgsHandler) {
          throw new UnexpectedServerError(`Route parameter not registered for parameter: ${param.Name},
            in method: ${String(route.Method)},
            in controller: ${self.constructor.name}. Check if you have registered it in DI container.`);
        }

        const { Args, CallData } = await routeArgsHandler.extract(callData, callArgs, param, req, res, route);

        callData = CallData;
        callArgs[param.Index] = Args;
      }

      return callArgs;
    }
  }
}

export class Controllers extends AsyncService {
  /**
   * File-scanned controller types (no instances). Each entry's `type` is
   * registered as `BaseController` in DI during `resolve()`, then every
   * controller — file-scanned and bootstrapper-registered alike — is
   * resolved through `Array.ofType(BaseController)`.
   */
  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.controllers')
  public Controllers!: Promise<Array<ClassInfo<BaseController>>>;

  @Logger('http')
  protected Log!: Log;

  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject()
  protected Server!: HttpServer;

  @Autoinject()
  protected ControllersCache!: DefaultControllerCache;

  /**
   * Single Express router that all controllers' routers are mounted onto.
   * It occupies one fixed position in the parent Express stack, so
   * dynamically-added controllers (via {@link add}) land at the right place
   * automatically — Express evaluates sub-router stacks lazily on each
   * request. NotFound / Error middleware live AFTER this router via the
   * standard ServerMiddleware.after() lifecycle.
   */
  protected ControllersRouter!: Express.Router;

  /**
   * Tracks which controller types have already been route-registered so
   * {@link add} is idempotent.
   */
  protected RegisteredTypes: Set<Class<BaseController>> = new Set();

  /**
   * Dynamically register a controller after startup. Equivalent to having
   * declared it via @Injectable / file-scan / bootstrapper registration
   * before `resolve()` ran, but usable at any point.
   *
   * Registers the type as BaseController (idempotent), resolves the
   * singleton instance, runs the per-controller cache + descriptor setup,
   * and mounts the controller's Router on the shared ControllersRouter.
   *
   * No Express stack mutation needed: the shared router was mounted once
   * during resolve() and lives at a fixed slot; the new controller's router
   * just becomes another entry in the shared router's internal stack.
   */
  public async add(type: Class<BaseController>): Promise<void> {
    if (this.RegisteredTypes.has(type)) {
      this.Log.trace(`Controller ${type.name} already registered, skipping`);
      return;
    }

    DI.register(type as any).as(BaseController);
    const instance = (await DI.resolve(type)) as BaseController;

    const ci = new ClassInfo<BaseController>();
    ci.name = type.name;
    ci.type = type;
    ci.instance = instance;
    ci.file = '<dynamic>';

    await this.register(ci);
  }

  public async register(controller: ClassInfo<BaseController>) {
    this.Log.trace(`Loading controller: ${controller.name}`);

    if (controller.type && this.RegisteredTypes.has(controller.type)) {
      this.Log.trace(`Controller ${controller.name} already registered, skipping`);
      return;
    }

    const parameters = await this.ControllersCache.getCache(controller);
    if(!controller.instance){
      this.Log.warn(`Controller ${controller.name} in file ${controller.file} is not resolved. Make sure it is decorated with @injectable and has a public constructor without required parameters`);
      return;
    }

    if (!controller.instance.Descriptor) {
      this.Log.warn(`Controller ${controller.name} in file ${controller.file} dont have descriptor or routes defined`);
    } else {
      for (const [name, route] of controller.instance.Descriptor.Routes) {
        if (parameters[name as string]) {
          const member = parameters[name as string];

          for (const [index, rParam] of route.Parameters) {
            const pName = member[index];
            if (pName) {
              rParam.Name = pName;
            }
          }
        } else {
          this.Log.error(`Controller ${controller.name} does not have member ${name as string} for route ${route.Path}`);
        }
      }


      if(!controller.instance.Router){
        this.Log.warn(`Controller ${controller.name} in file ${controller.file} has no router instance. Check if it extends BaseController and super.resolve() is called in resolve method`);
        return;
      }

      this.ControllersRouter.use(controller.instance.Router);
      if (controller.type) {
        this.RegisteredTypes.add(controller.type);
      }
    }
  }

  public async resolve(): Promise<void> {

    await super.resolve();

    // Shared sub-router. All controller routers mount onto this one; this
    // one mounts onto Express exactly once. Dynamic adds land here too,
    // which is how `add()` avoids the old Express-stack juggling.
    this.ControllersRouter = Express.Router();

    // Two registration paths converge here:
    //  1. Directory-scanned controllers (existing behavior). @ListFromFiles
    //     hands us the class types; we register each as `BaseController` so
    //     they show up in the DI collection.
    //  2. Bootstrapper-registered controllers. A package's Bootstrapper can
    //     conditionally call `DI.register(MyController).as(BaseController)`
    //     before this service resolves. Those classes are already in the
    //     collection by the time we get here.
    // Resolving `Array.ofType(BaseController)` then instantiates everything
    // in a single pass — file-scanned + bootstrap-registered, with class
    // identity dedupe (multiple `as(BaseController)` calls for the same type
    // resolve to one singleton).
    const listed = await this.Controllers;
     
    for (const ci of _.uniqBy(listed, c => c.name)) {
      if (!ci.type){
        this.Log.warn(`Controller ${ci.name} in file ${ci.file} has no type. Make sure it is decorated with @injectable and has a public constructor without required parameters`);
        continue;
      };
      
      DI.register(ci.type).as(BaseController);
      this.Log.trace(`Controller ${ci.name} from ${ci.file} registered as BaseController`);
    }

    const instances = (await DI.resolve(Array.ofType(BaseController))) as BaseController[];

    for (const instance of instances) {
      const type = instance.constructor as Class<BaseController>;
      const ci = Object.assign(new ClassInfo<BaseController>(), {
        name: type.name,
        type,
        instance,
        file: '<di>',
      } as Partial<ClassInfo<BaseController>>);
      // The file-scanned entry has no instance (List, not Resolve) — patch it.
      if (!ci.instance) ci.instance = instance;
      await this.register(ci);
    }

    // Mount the shared controllers router on the Express app ONCE. From here
    // on, anything added via `this.ControllersRouter.use(...)` (including
    // future `add()` calls) is picked up by Express automatically.
    // NotFound / Error handling is handled by NotFoundMiddleware and
    // ErrorHandlerMiddleware (ServerMiddleware impls), attached to the
    // Express stack tail during HttpServer.start().
    this.Server.use(this.ControllersRouter);
  }
}
