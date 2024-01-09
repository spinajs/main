import { DI, Autoinject, TypedArray, isClass } from '@spinajs/di';
import { ParameterType, IRouteParameter, IRouteCall, IRoute, Request } from './../interfaces.js';
import * as express from 'express';
import { ArgHydrator } from './ArgHydrator.js';
import _ from 'lodash';
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

  protected async tryHydrateParam(arg: any, routeParameter: IRouteParameter, route: IRoute) {
    let result = null;
    let schema = null;
    let hydrator = null;

    // first validate route parameter / body params etc
    if (route.Schema && route.Schema[routeParameter.Name]) {
      schema = route.Schema[routeParameter.Name];
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
