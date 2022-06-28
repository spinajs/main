import { ParameterType, IRouteParameter, IRouteCall, IRoute } from './../interfaces';
import * as express from 'express';
import { ArgHydrator } from './ArgHydrator';
import { DI } from '@spinajs/di';
import _ from 'lodash';

export interface IRouteArgsResult {
  CallData: IRouteCall;
  Args: any;
}

export interface IRouteArgs {
  SupportedType: ParameterType | string;

  extract(callData: IRouteCall, routeParameter: IRouteParameter, req: express.Request, res: express.Response, route?: IRoute): Promise<IRouteArgsResult>;
}

export abstract class RouteArgs implements IRouteArgs {
  abstract get SupportedType(): ParameterType | string;

  public abstract extract(callData: IRouteCall, routeParameter: IRouteParameter, req: express.Request, res: express.Response, route?: IRoute): Promise<IRouteArgsResult>;

  protected async tryHydrate(arg: any, param: IRouteParameter) {
    const hydrator = Reflect.getMetadata('custom:arg_hydrator', param.RuntimeType);
    if (hydrator) {
      const hInstance = await DI.resolve<ArgHydrator>(hydrator.hydrator, hydrator.options);
      const result = await hInstance.hydrate(arg);

      return [true, result];
    }

    return [false, null];
  }

  protected fromRuntimeType(param: IRouteParameter, arg: any) {
    switch (param.RuntimeType.name) {
      // query params are always sent as strings, even numbers,
      // we must try to parse them as integers / booleans / objects
      case 'String':
        return arg;
      case 'Number':
        return Number(arg);
      case 'Boolean':
        return (arg as string).toLowerCase() === 'true' ? true : false;
      case 'Object':
        return _.isString(arg) ? JSON.parse(arg) : arg;
      default:
        return new param.RuntimeType(_.isString(arg) ? JSON.parse(arg) : arg);
    }
  }
}
