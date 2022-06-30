import { TypedArray } from '@spinajs/di';
import { ParameterType, IRouteParameter, IRouteCall, IRoute } from './../interfaces';
import * as express from 'express';
import { ArgHydrator } from './ArgHydrator';
import { DI } from '@spinajs/di';
import _ from 'lodash';
import { DateTime } from 'luxon';

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

  protected handleDate(arg: any): DateTime {
    const milis = Number(arg);
    if (!isNaN(milis)) {
      return DateTime.fromSeconds(milis);
    }

    if (_.isString(arg)) {
      return DateTime.fromISO(arg as string);
    }

    return DateTime.invalid('no iso or unix timestamp');
  }

  protected async tryHydrateParam(arg: any, routeParameter: IRouteParameter) {
    let result = null;

    const [hydrated, hValue] = await this.tryHydrateObject(arg, routeParameter);
    if (hydrated) {
      result = hValue;
    } else {
      result = this.fromRuntimeType(routeParameter, arg);
    }

    return result;
  }

  protected async tryHydrateObject(arg: any, param: IRouteParameter) {
    let hydrator = null;
    if (param.RuntimeType instanceof TypedArray) {
      hydrator = Reflect.getMetadata('custom:arg_hydrator', (param.RuntimeType as TypedArray<any>).Type);
    } else {
      hydrator = Reflect.getMetadata('custom:arg_hydrator', param.RuntimeType);
    }

    if (hydrator) {
      const hInstance = await DI.resolve<ArgHydrator>(hydrator.hydrator, hydrator.options);
      const result = await hInstance.hydrate(arg, param);

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
        return arg ? Number(arg) : null;
      case 'Boolean':
        return arg ? (arg === 1 ? true : (arg as string).toLowerCase() === 'true' ? true : false) : false;
      case 'Object':
        return _.isString(arg) ? JSON.parse(arg) : arg;
      case 'DateTime':
        return this.handleDate(arg);
      case 'TypedArray':
        const type = (param.RuntimeType as TypedArray<any>).Type as any;
        return new type(_.isString(arg) ? JSON.parse(arg) : arg);
      default:
        return new param.RuntimeType(_.isString(arg) ? JSON.parse(arg) : arg);
    }
  }
}
