import { AsyncLocalStorage } from 'node:async_hooks';
import { isPromise } from 'node:util/types';
import { basename } from 'node:path';
import * as fs from 'node:fs';

import Express from 'express';

import _ from 'lodash';

import { AsyncService, IContainer, Autoinject, DI, ClassInfo, Container, Constructor } from '@spinajs/di';
import { UnexpectedServerError, IOFail, ResourceNotFound } from '@spinajs/exceptions';
import { ResolveFromFiles } from '@spinajs/reflection';
import { Logger, Log } from '@spinajs/log';
import { DataValidator } from '@spinajs/validation';
import { Configuration } from '@spinajs/configuration';
import { HttpServer } from './server.js';
import { RouteArgs } from './route-args/index.js';
import { Request as sRequest, Response, IController, IControllerDescriptor, IPolicyDescriptor, RouteMiddleware, IRoute, IMiddlewareDescriptor, BasePolicy, ParameterType, IActionLocalStoregeContext, Request, ResponseFunction, HTTP_STATUS_CODE, HttpAcceptHeaders, Response as HttpResponse } from './interfaces.js';
import { CONTROLLED_DESCRIPTOR_SYMBOL } from './decorators.js';
import { tryGetHash } from '@spinajs/util';
import { DefaultControllerCache } from './cache.js';
import { ServerError } from './response-methods/serverError.js';
import randomstring from 'randomstring';



export abstract class BaseController extends AsyncService implements IController {
  /**
   * Array index getter
   */
  [action: string]: any;

  protected _router: Express.Router;

  @Autoinject(Container)
  protected _container: IContainer;

  @Autoinject()
  protected _validator: DataValidator;

  @Logger('http')
  protected _log: Log;

  @Autoinject()
  protected _actionLocalStorage: AsyncLocalStorage<IActionLocalStoregeContext>;

  @Autoinject(Configuration)
  protected _cfg: Configuration;

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

  protected __handle_response__() {
    return (req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
      if (!res.locals.response) {
        next(new ResourceNotFound(`Resource not found ${req.method}:${req.originalUrl}`));
        return;
      }

      res.locals.response
        .execute(req, res)
        .then((callback: ResponseFunction) => {
          if (callback) {
            return callback(req, res);
          }
        })
        .catch((err: Error) => {
          next(err);
        });
    };
  }

  protected __handle_error__() {
    return (err: any, req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
      if (!err) {
        return next();
      }


      const error = {
        /**
         * By default Error object dont copy values like message ( they are not enumerable )
         * It only copies custom props added to Error ( via inheritance )
         */
        ...err,

        // make sure error message is added
        message: err.message,
        stack: {},
      };

      // in dev mode add stack trace for debugging
      if (this.AppEnv === 'development') {
        error.stack = err.stack ? err.stack : err.parameter && err.parameter.stack;
      }

      this._log.error(err, `Error in controller ${req.method} ${this.constructor.name} at path ${req.originalUrl}`);


      let response: HttpResponse = null;
      const rMap = DI.get<Map<string, Constructor<HttpResponse>>>('__http_error_map__');
      if (rMap.has(err.constructor.name)) {
        const httpResponse = rMap.get(err.constructor.name);
        response = new httpResponse(error);
      } else {
        this._log.warn(`Error type ${error.constructor} dont have assigned http response. Map error to response via _http_error_map__ in DI container`);
        response = new ServerError(error);
      }

      response
        .execute(req, res)
        .then((callback?: ResponseFunction | void) => {
          if (callback) {
            callback(req, res);
          }
        })
        .catch((err: Error) => {
          // last resort error handling

          this._log.fatal(err, `Cannot send error response`);
          res.status(HTTP_STATUS_CODE.INTERNAL_ERROR);

          if (req.accepts('html') && (this.HttpConfig.AcceptHeaders & HttpAcceptHeaders.HTML) === HttpAcceptHeaders.HTML) {
            // final fallback rendering error fails, we render embedded html error page
            const ticketNo = randomstring.generate(7);
            res.send(this.HttpConfig.FatalTemplate.replace('{ticket}', ticketNo));
          } else {
            res.json(error);
          }
        });
    }
  };

  public async resolve() {
    const self = this;

    if (!this.Descriptor) {
      this._log.warn(`Controller ${this.constructor.name} does not have descriptor. It its abstract or base class ignore this message.`);
      return;
    }

    this._router = Express.Router();
    this._actionLocalStorage = DI.get(AsyncLocalStorage<IActionLocalStoregeContext>);

    for (const [, route] of this.Descriptor.Routes) {
      const handlers: Express.RequestHandler[] = [];

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
        path = `/${this.BasePath}/${route.Method}`;
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
                self._log.trace(`Policy ${policyType} is used in controller ${self.constructor.name}::${route.Method} at path ${path}`);
                return self._container.resolve<BasePolicy>(policyType, m.Options);
              }
            } else {
              self._log.trace(`Policy ${m.Type.name} is used in controller ${self.constructor.name}::${route.Method} at path ${path}`);
              return self._container.resolve<BasePolicy>(m.Type, m.Options);
            }
          })
          .filter((x) => x !== null),
      );
      const enabledMiddlewares = middlewares.filter((m) => m.isEnabled(route, this));

      this._log.trace(`Registering route ${route.Type.toUpperCase()} ${this.constructor.name}::${route.Method} at ${path}`);

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
                this._log.trace(`Policy succeded for route ${self.constructor.name}:${route.Method} ${self.BasePath}/${route.Path || route.Method}, policy: ${p.constructor.name}`);
              })
              .catch((err) => {
                this._log.trace(`Policy failed for route ${self.constructor.name}:${route.Method} ${self.BasePath}/${route.Path || route.Method} error ${err}, policy: ${p.constructor.name}`);
                throw err;
              });
          })).then((results) => {
            const failed = results.find(r => r.status === 'rejected');
            if (failed && "reason" in failed) {
              throw next(failed.reason);
            }
            next();
          })
      });
      handlers.push(...enabledMiddlewares.map((m) => _invokeAction(m, m.onBefore.bind(m), route)));

      const acionWrapper = async (req: sRequest, res: Express.Response, next: Express.NextFunction) => {
        try {
          await this._actionLocalStorage.run(req.storage, async () => {
            const args = (await _extractRouteArgs(route, req, res)).concat([req, res, next]);

            try {
              const result = this[route.Method].call(this, ...args);

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
        this._log.warn(`Unknown route type for ${this.constructor.name}::${route.Method} at path ${path}`);
        return;
      }

      handlers.push(this.__handle_response__());
      handlers.push(this.__handle_error__() as any);

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

      for (const [, param] of route.Parameters) {
        const routeArgsHandler = await tryGetHash(argsCache, param.Type, () => DI.resolve(param.Type));
        if (!routeArgsHandler) {
          throw new UnexpectedServerError(`invalid route parameter type for param: ${param.Name},
            method: ${route.Method},
            controller: ${self.constructor.name}`);
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
   * Loaded controllers
   */
  @ResolveFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.controllers')
  public Controllers: Promise<Array<ClassInfo<BaseController>>>;

  @Logger('http')
  protected Log: Log;

  @Autoinject(Container)
  protected Container: IContainer;

  @Autoinject()
  protected Server: HttpServer;

  @Autoinject()
  protected ControllersCache: DefaultControllerCache;

  public async registerFromFile(file: string) {
    if (!fs.existsSync(file)) {
      throw new IOFail(`Controller file at path ${file} not found`);
    }

    const types = await DI.__spinajs_require__(file.replace('.js', '.d.ts'));
    const typeName = basename(basename(file, '.js'), '.ts');
    const type = (types as any)[typeName];
    const instance = await DI.resolve<BaseController>(type);
    const ci = new ClassInfo<BaseController>();

    ci.file = file.replace('.js', '.d.ts');
    ci.instance = instance;
    ci.name = typeName;
    ci.type = type;

    return await this.register(ci);
  }

  public async register(controller: ClassInfo<BaseController>) {
    this.Log.trace(`Loading controller: ${controller.name}`);

    const parameters = await this.ControllersCache.getCache(controller);
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

      this.Server.use(controller.instance.Router);
    }
  }

  public async resolve(): Promise<void> {
    const controllers = await this.Controllers;
    for (const c of controllers) {
      await this.register(c);
    }
  }
}
