import { Socket } from 'socket.io';
import { tryGetHash } from '@spinajs/util';
import { Configuration } from '@spinajs/configuration';
import { AsyncService, Autoinject, Constructor, Container, DI, IContainer, isClass, TypedArray } from '@spinajs/di';
import { ArgHydrator, CONTROLLED_DESCRIPTOR_SYMBOL, IRouteParameter, ParameterType } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log-common';
import { DataValidator } from '@spinajs/validation';
import _ from 'lodash';
import { UnexpectedServerError } from '@spinajs/exceptions';

/**
 * Middleware used server - wide ( for all incoming socket connections )
 */
export abstract class SocketServerMiddleware extends AsyncService {
  /**
   * Execution order, ascending execution ( lower first )
   */
  public abstract get Order(): number;

  /**
   *
   * Middleware func run for ALL sockets before message is proceeded
   * Example for auth middleware or logging, etc.
   *
   * @param socket
   * @param next
   */
  public abstract before(socket: Socket): Promise<void>;

  /**
   *
   * Executed on connection event
   *
   * @param socket
   */
  public abstract onConnect(socket: Socket): Promise<void>;

  /**
   *
   * Executed on disconnect event
   *
   * @param socket
   */
  public abstract onDisconnect(socket: Socket, reason: string): Promise<void>;
}

/**
 * Middleware for specific socket
 */
export abstract class SocketMiddleware extends AsyncService {
  /**
   *
   * Middleware func before message is proceeded for this socket
   * Example for auth middleware
   *
   * @param socket
   * @param next
   */
  public abstract execute(socket: Socket, event: string, args: any[]): Promise<void>;
}

export interface ISocketMiddlewareDescriptor {
  Type: Constructor<SocketMiddleware>;

  Options: any[];
}

/**
 * Describes parameters passed to socket event
 */
export interface ISocketEventParameter extends IRouteParameter {}

export interface ISocketEvent {
  /**
   * Event name
   */
  Name: string;

  Method: string;

  Parameters: Map<number, ISocketEventParameter>;

  Schema: any;
}

/**
 * Descriptor for controller
 */
export interface ISocketControllerDescriptor {
  /**
   * Controller routes
   */
  Events: Map<string | symbol, ISocketEvent>;

  /**
   * Controller - wise middlewares
   */
  Middlewares: ISocketMiddlewareDescriptor[];

  /**
   * Sockets room ( optional ), if not set  "/" is set ( main room )
   */
  Room?: string;
}

/**
 * Route action call spefici data. Used to pass data / arguments when parsing
 * action parameters for specific call. Eg. to parse form data, and extract it
 * as different arguments.
 */
export interface ISocketEventCall {
  Payload: any;
}

export interface ISocketEventArgsResult {
  CallData: ISocketEventCall;
  Args: any;
}

export interface ISocketRouteArgs {
  SupportedType: ParameterType | string;

  extract(callData: ISocketEventCall, routeParameter: IRouteParameter, incomingArgs: any[], socket: Socket): Promise<ISocketEventArgsResult>;
}

export abstract class SocketRouteArgs implements ISocketRouteArgs {
  @Autoinject()
  protected Validator: DataValidator;

  abstract get SupportedType(): ParameterType | string;

  public abstract extract(callData: ISocketEventCall, routeParameter: IRouteParameter, incomingArgs: any[], socket: Socket): Promise<ISocketEventArgsResult>;

  protected async tryHydrateParam(arg: any, routeParameter: IRouteParameter, event: ISocketEvent) {
    let result = null;
    let schema = null;
    let hydrator = null;

    // first validate route parameter / body params etc
    if (event.Schema && event.Schema[routeParameter.Name]) {
      schema = event.Schema[routeParameter.Name];
    } else if (routeParameter.Schema) {
      schema = routeParameter.Schema;
    } else if (routeParameter.RouteParamSchema) {
      schema = routeParameter.RouteParamSchema;
    } else {
      schema = this.Validator.extractSchema(routeParameter.RuntimeType);
    }

    if (this.isRuntimeType(routeParameter)) {
      result = this.fromRuntimeType(routeParameter, arg);

      if (schema) {
        this.Validator.validate(schema, result);
      }
    } else {
      hydrator = this.getHydrator(routeParameter);
      result = hydrator ? arg : this.tryExtractObject(arg, routeParameter);

      if (schema) {
        this.Validator.validate(schema, result);
      }

      if (hydrator) {
        result = await this.tryHydrateObject(result, routeParameter, hydrator);
      }
    }

    return result;
  }

  protected async tryHydrateObject(arg: any, route: IRouteParameter, hydrator: any) {
    const hInstance = await DI.resolve<ArgHydrator>(hydrator.hydrator, hydrator.options);
    return await hInstance.hydrate(arg, route);
  }

  protected getHydrator(param: IRouteParameter) {
    let hydrator = null;
    if (param.RuntimeType instanceof TypedArray) {
      hydrator = Reflect.getMetadata('custom:arg_hydrator', (param.RuntimeType as TypedArray<any>).Type);
    } else {
      hydrator = Reflect.getMetadata('custom:arg_hydrator', param.RuntimeType);
    }

    return hydrator;
  }

  protected tryExtractObject(arg: any, param: IRouteParameter) {
    if (isClass(param.RuntimeType)) {
      return new (param.RuntimeType as any)(_.isString(arg) ? JSON.parse(arg) : arg);
    } else if (param.RuntimeType instanceof TypedArray) {
      const type = (param.RuntimeType as TypedArray<any>).Type as any;
      const arrData = _.isString(arg) ? JSON.parse(arg) : arg;
      return arrData ? arrData.map((x: any) => new type(x)) : [];
    } else if (param.RuntimeType.name === 'Object' || param.RuntimeType.name === 'Array') {
      return _.isString(arg) ? JSON.parse(arg) : arg;
    }

    return arg;
  }

  protected isRuntimeType(param: IRouteParameter) {
    return ['String', 'Number', 'BigInt', 'Boolean', 'Undefined', 'Null'].indexOf(param.RuntimeType.name) !== -1;
  }

  protected fromRuntimeType(param: IRouteParameter, arg: any) {
    switch (param.RuntimeType.name) {
      // query params are always sent as strings, even numbers,
      // we must try to parse them as integers / booleans / objects
      case 'String':
        return arg;
      case 'Number':
        return arg ? Number(arg) : undefined;
      case 'BigInt':
        return BigInt(arg);
      case 'Boolean':
        return arg ? (arg === 1 ? true : (arg as string).toLowerCase() === 'true' ? true : false) : false;
      case 'Undefined':
        return undefined;
      case 'Null':
        return null;
      default:
        return new param.RuntimeType(_.isString(arg) ? JSON.parse(arg) : arg);
    }
  }
}

export abstract class SocketController extends AsyncService {
  /**
   * Event method getter
   */
  [action: string]: any;

  /**
   * Controller descriptor
   */
  public get Descriptor(): ISocketControllerDescriptor {
    return Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, this) as ISocketControllerDescriptor;
  }

  @Autoinject(Container)
  protected _container: IContainer;

  @Logger('http')
  protected _log: Log;

  @Autoinject(Configuration)
  protected _cfg: Configuration;

  @Autoinject(SocketMiddleware)
  protected _middlewares: SocketMiddleware[];

  public async resolve() {
    if (!this.Descriptor) {
      this._log.warn(`Socket controller ${this.constructor.name} does not have descriptor. If its abstract or base class ignore this message.`);
      return;
    }
  }

  public async attach(socket: Socket) {
    const self = this;

    if (this.Descriptor.Room) {
      socket.join(this.Descriptor.Room);
    }

    this._middlewares.forEach((m) => {
      socket.use(([event, ...args], next) => {
        m.execute(socket, event, args)
          .catch((err) => {
            next(err);
          })
          .then(() => {
            next();
          });
      });
    });

    for (const [, event] of this.Descriptor.Events) {
      socket.on(event.Name, async (...args) => {
        const a = await _extractEventArgs(event, args);
        await this[event.Method].call(this, ...a);
      });
    }

    async function _extractEventArgs(route: ISocketEvent, incomingArgs: any) {
      const callArgs = new Array(route.Parameters.size);
      const argsCache = new Map<ParameterType | string, SocketRouteArgs>();

      let callData = {
        Payload: {},
      };

      for (const [, param] of route.Parameters) {
        const routeArgsHandler = await tryGetHash(argsCache, param.Type, () => DI.resolve(param.Type));
        if (!routeArgsHandler) {
          throw new UnexpectedServerError(`invalid route parameter type for param: ${param.Name},
              method: ${route.Name},
              controller: ${self.constructor.name}`);
        }

        const { Args, CallData } = await routeArgsHandler.extract(callData, param, incomingArgs, socket);

        callData = CallData;
        callArgs[param.Index] = Args;
      }

      return callArgs;
    }
  }
}
