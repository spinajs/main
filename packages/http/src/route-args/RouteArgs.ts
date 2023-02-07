import { Autoinject, TypedArray } from '@spinajs/di';
import { ParameterType, IRouteParameter, IRouteCall, IRoute, Request } from './../interfaces.js';
import * as express from 'express';
import { ArgHydrator } from './ArgHydrator.js';
import { DI } from '@spinajs/di';
import _ from 'lodash';
import { DateTime } from 'luxon';
import { DataValidator } from '@spinajs/validation';

export interface IRouteArgsResult {
  CallData: IRouteCall;
  Args: any;
}

export interface IRouteArgs {
  SupportedType: ParameterType | string;

  extract(callData: IRouteCall, routeParameter: IRouteParameter, req: Request, res: express.Response, route?: IRoute): Promise<IRouteArgsResult>;
}

export abstract class RouteArgs implements IRouteArgs {
  @Autoinject()
  protected Validator: DataValidator;

  abstract get SupportedType(): ParameterType | string;

  public abstract extract(callData: IRouteCall, routeParameter: IRouteParameter, req: Request, res: express.Response, route?: IRoute): Promise<IRouteArgsResult>;

  protected handleDate(arg: any): DateTime {
    const milis = Number(arg);
    if (!Number.isNaN(milis)) {
      return DateTime.fromSeconds(milis);
    }

    if (_.isString(arg)) {
      return DateTime.fromISO(arg as string);
    }

    return DateTime.invalid('no iso or unix timestamp');
  }

  protected async tryHydrateParam(arg: any, routeParameter: IRouteParameter, route: IRoute) {
    let result = null;
    let schema = null;

    // first validate route parameter / body params etc
    if (route.Schema && route.Schema[routeParameter.Name]) {
      schema = route.Schema[routeParameter.Name];
    } else if (routeParameter.Schema) {
      schema = routeParameter.Schema;
    }
    else if (routeParameter.RouteParamSchema) {
      schema = routeParameter.RouteParamSchema;
    }

    // TODO:
    // extract schema without hydrating
    // to prevent creating object if data is invalid
    result = await this.tryHydrateObject(arg, routeParameter);
    if (result && typeof result === 'object') {
        schema = this.Validator.extractSchema(result);
    }
    if (schema) {
            this.Validator.validate(schema, arg);
    }
    if (!result) {
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
      return await hInstance.hydrate(arg, param);
    } else if (param.RuntimeType.name === 'Object' || param.RuntimeType.name === 'Array') {
      return _.isString(arg) ? JSON.parse(arg) : arg;
    } else if (param.RuntimeType.name === 'DateTime') {
      return this.handleDate(arg);
    } else if (param.RuntimeType instanceof TypedArray) {
      const type = (param.RuntimeType as TypedArray<any>).Type as any;
      const arrData = _.isString(arg) ? JSON.parse(arg) : arg;
      return arrData ? arrData.map((x: any) => new type(x)) : [];
    } else if (['Number', 'String', 'Boolean', 'Null', 'Undefined', 'BigInt', 'Symbol'].indexOf(param.RuntimeType.name) === -1) {
      return new param.RuntimeType(_.isString(arg) ? JSON.parse(arg) : arg);
    }

    return undefined;
  }

  protected fromRuntimeType(param: IRouteParameter, arg: any) {
    switch (param.RuntimeType.name) {
      // query params are always sent as strings, even numbers,
      // we must try to parse them as integers / booleans / objects
      case 'String':
        return arg;
      case 'Number':
        return arg ? Number(arg) : undefined;
      case 'Boolean':
        return arg ? (arg === 1 ? true : (arg as string).toLowerCase() === 'true' ? true : false) : false;
      default:
        return new param.RuntimeType(_.isString(arg) ? JSON.parse(arg) : arg);
    }
  }
}
