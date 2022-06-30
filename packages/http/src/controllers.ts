import { IController, IControllerDescriptor, IPolicyDescriptor, BaseMiddleware, IRoute, IMiddlewareDescriptor, BasePolicy, ParameterType } from './interfaces';
import { AsyncModule, IContainer, Autoinject, DI, Container } from '@spinajs/di';
import * as express from 'express';
import { CONTROLLED_DESCRIPTOR_SYMBOL } from './decorators';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { ClassInfo, TypescriptCompiler, ResolveFromFiles } from '@spinajs/reflection';
import { HttpServer } from './server';
import { Logger, Log } from '@spinajs/log';
import { DataValidator } from '@spinajs/validation';
import { RouteArgs, FromFormBase } from './route-args';

export abstract class BaseController extends AsyncModule implements IController {
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
 
  public async resolveAsync() {
    const self = this;

    this._router = express.Router();

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

      const middlewares = await Promise.all<BaseMiddleware>(
        this.Descriptor.Middlewares.concat(route.Middlewares || []).map((m: IMiddlewareDescriptor) => {
          return self._container.resolve(m.Type, m.Options);
        }),
      );
      const policies = await Promise.all<BasePolicy>(
        this.Descriptor.Policies.concat(route.Policies || []).map((m: IPolicyDescriptor) => {
          return self._container.resolve(m.Type, m.Options);
        }),
      );
      const enabledMiddlewares = middlewares.filter((m) => m.isEnabled(route, this));

      this._log.trace(`Registering route ${route.Type.toUpperCase()} ${this.constructor.name}::${route.Method} at ${path}`);

      handlers.push(...policies.filter((p) => p.isEnabled(route, this)).map((p) => _invokePolicyAction(p, p.execute.bind(p), route)));
      handlers.push(...enabledMiddlewares.map((m) => _invokeAction(m, m.onBeforeAction.bind(m))));

      const acionWrapper = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
        try {
          const args = (await _extractRouteArgs(route, req, res)).concat([req, res, next]);
          res.locals.response = await this[route.Method].call(this, ...args);
          next();
        } catch (err) {
          next(err);
        }
      };

      Object.defineProperty(acionWrapper, 'name', {
        value: this.constructor.name,
        writable: true,
      });

      handlers.push(acionWrapper);
      handlers.push(...enabledMiddlewares.map((m) => _invokeAction(m, m.onAfterAction.bind(m))));

      // register to express router
      (this._router as any)[route.InternalType as string](path, handlers);
    }

    function _invokeAction(source: any, action: any) {
      const wrapper = (req: express.Request, res: express.Response, next: express.NextFunction) => {
        action(req, res, self)
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

    async function _extractRouteArgs(route: IRoute, req: express.Request, res: express.Response) {
      const args = new Array<any>(route.Parameters.size);
      let callData = {
        Payload: {},
      };

      const argsCache = new Map<ParameterType | string, RouteArgs>();
      let formCache: FromFormBase = null;

      for (const [, param] of route.Parameters) {
        if (!argsCache.has(param.Type)) {
          const fArg = await DI.resolve<RouteArgs>(param.Type, formCache ? [formCache.Data] : []);
          argsCache.set(param.Type, fArg);

          if (!formCache && (param.Type === ParameterType.FormField || param.Type === ParameterType.FromCSV || param.Type === ParameterType.FromJSONFile || param.Type === ParameterType.FromForm || param.Type === ParameterType.FromFile)) {
            formCache = fArg as any as FromFormBase;
          }
        }

        const extractor = argsCache.get(param.Type);
        if (!extractor) {
          throw new UnexpectedServerError('invalid route parameter type for param: ' + param.Name);
        }

        const { Args } = await extractor.extract(callData, param, req, res, route);
        param.Schema ? self._validator.validate(param.Schema, Args) : self._validator.validate(Args);
        args[param.Index] = Args;
      }

      return args;
    }
  }
}

export class Controllers extends AsyncModule {
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

  public async register(controller: ClassInfo<BaseController>) {
    this.Log.trace(`Loading controller: ${controller.name}`);

    const compiler = new TypescriptCompiler(controller.file.replace('.js', '.d.ts'));
    const members = compiler.getClassMembers(controller.name);

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

  public async resolveAsync(): Promise<void> {
    /**
     * globally register controller validator, we use ajv lib
     * we use factory func register as singlegon
     */

    DI.register(DataValidator).asSelf().singleInstance();

    // extract parameters info from controllers source code & register in http server
    for (const controller of await this.Controllers) {
      this.register(controller);
    }
  }
}
