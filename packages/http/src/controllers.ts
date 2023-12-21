import { AsyncLocalStorage } from 'node:async_hooks';
import { isPromise } from 'node:util/types';
import { basename } from 'node:path';
import * as fs from 'node:fs';

import * as express from 'express';
import _ from 'lodash';

import { AsyncService, IContainer, Autoinject, DI, ClassInfo, Container } from '@spinajs/di';
import { UnexpectedServerError, IOFail } from '@spinajs/exceptions';
import { TypescriptCompiler, ResolveFromFiles } from '@spinajs/reflection';
import { Logger, Log } from '@spinajs/log';
import { DataValidator } from '@spinajs/validation';
import { Configuration } from '@spinajs/configuration';
import { HttpServer } from './server.js';
import { RouteArgs } from './route-args/index.js';
import { Request as sRequest, Response, IController, IControllerDescriptor, IPolicyDescriptor, RouteMiddleware, IRoute, IMiddlewareDescriptor, BasePolicy, ParameterType, IActionLocalStoregeContext, Request } from './interfaces.js';
import { CONTROLLED_DESCRIPTOR_SYMBOL } from './decorators.js';
import { tryGetHash } from '@spinajs/util';

export abstract class BaseController extends AsyncService implements IController {
  /**
   * Array index getter
   */
  [action: string]: any;

  protected _router: express.Router;

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
  public get Router(): express.Router {
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
    const self = this;

    if (!this.Descriptor) {
      this._log.warn(`Controller ${this.constructor.name} does not have descriptor. It its abstract or base class ignore this message.`);
      return;
    }

    this._router = express.Router();
    this._actionLocalStorage = DI.get(AsyncLocalStorage<IActionLocalStoregeContext>);

    for (const [, route] of this.Descriptor.Routes) {
      const handlers: express.RequestHandler[] = [];

      let path = '';
      if (route.Path) {
        if (route.Path === '/') {
          path = `/${this.BasePath}`;
        } else {
          path = `/${this.BasePath}/${route.Path}`;
        }
      } else {
        path = `/${this.BasePath}/${route.Method}`;
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

      handlers.push(...policies.filter((p) => p.isEnabled(route, this)).map((p) => _invokePolicyAction(p, p.execute.bind(p), route)));
      handlers.push(...enabledMiddlewares.map((m) => _invokeAction(m, m.onBefore.bind(m), route)));

      const acionWrapper = async (req: sRequest, res: express.Response, next: express.NextFunction) => {
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
      (this._router as any)[route.InternalType as string](path, handlers);
    }

    function _invokeAction(source: any, action: any, route: IRoute) {
      const wrapper = (req: express.Request, res: express.Response, next: express.NextFunction) => {
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

    function _invokePolicyAction(source: any, action: any, route: IRoute) {
      const wrapper = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
        action(req, route, self)
          .then(next)
          .catch((err: any) => {
            self._log.trace(`route ${self.constructor.name}:${route.Method} ${self.BasePath}${route.Path} error ${err}, policy: ${source.constructor.name}`);

            next(err);
          });
      };

      Object.defineProperty(wrapper, 'name', {
        value: source.constructor.name,
        writable: true,
      });

      return wrapper;
    }

    async function _extractRouteArgs(route: IRoute, req: Request, res: express.Response) {
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

        const { Args, CallData } = await routeArgsHandler.extract(callData, param, req, res, route);

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

    const compiler = new TypescriptCompiler(controller.file.replace('.js', '.d.ts'));
    const members = compiler.getClassMembers(controller.name);

    if (!controller.instance.Descriptor) {
      this.Log.warn(`Controller ${controller.name} in file ${controller.file} dont have descriptor or routes defined`);
    } else {
      for (const [name, route] of controller.instance.Descriptor.Routes) {
        if (members.has(name as string)) {
          const member = members.get(name as string);

          for (const [index, rParam] of route.Parameters) {
            const parameterInfo = member.parameters[index];
            if (parameterInfo) {
              rParam.Name = (parameterInfo.name as any).text;
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

    // extract parameters info from controllers source code & register in http server
    for (const controller of controllers.filter((x) => x !== undefined && x !== null)) {
      this.register(controller);
    }
  }
}
