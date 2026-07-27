import { DI, Autoinject, TypedArray, isClass } from '@spinajs/di';
import { ParameterType, IRouteParameter, IRouteCall, IRoute, Request } from './../interfaces.js';
import * as express from 'express';
import { ArgHydrator } from './ArgHydrator.js';
import _ from 'lodash';
import { DataValidator, ValidationFailed } from '@spinajs/validation';
import { InvalidArgument } from '@spinajs/exceptions';

/**
 * Extracts schema from runtime type. Handles TypedArray by extracting
 * schema from underlying type and wrapping it in array schema.
 * This is needed because TypeScript loses array element type information at runtime.
 * 
 * @param runtimeType - The runtime type to extract schema from
 * @param validator - DataValidator instance to use for schema extraction
 * @returns The extracted schema or null if not found
 */
export function extractSchemaFromRuntimeType(runtimeType: any, validator: DataValidator): any {
  if (runtimeType instanceof TypedArray) {
    const underlyingType = (runtimeType as TypedArray<any>).Type;
    const itemSchema = validator.extractSchema(underlyingType);
    if (itemSchema) {
      return {
        type: 'array',
        items: itemSchema,
      };
    }
    return null;
  }
  return validator.extractSchema(runtimeType);
}

export interface IRouteArgsResult {
  CallData: IRouteCall;
  Args: any;
}

export interface IRouteArgs {
  SupportedType: ParameterType | string;

  Priority?: number;

  extract(callData: IRouteCall, callArgs: unknown[], routeParameter: IRouteParameter, req: Request, res: express.Response, route?: IRoute): Promise<IRouteArgsResult>;
}

export abstract class RouteArgs implements IRouteArgs {
  @Autoinject()
  protected Validator: DataValidator;

  public Priority?: number;

  abstract get SupportedType(): ParameterType | string;

  public abstract extract(callData: IRouteCall, callArgs: unknown[], routeParameter: IRouteParameter, req: Request, res: express.Response, route?: IRoute): Promise<IRouteArgsResult>;

  protected async tryHydrateParam(arg: any, routeParameter: IRouteParameter, route: IRoute) {
    // Enforce presence for params explicitly marked `{ required: true }` BEFORE
    // the null/undefined skip below (absent optional params are intentionally
    // not validated). Params without the flag keep the old optional behavior.
    if ((routeParameter.Options as any)?.required === true && (arg === undefined || arg === null || arg === '')) {
      throw new ValidationFailed(`Parameter '${routeParameter.Name}' is required`, [
        {
          propertyName: routeParameter.Name,
          message: `Parameter '${routeParameter.Name}' is required`,
          keyword: 'required',
          params: { missingParameter: routeParameter.Name },
          schemaPath: '#/required',
          instancePath: routeParameter.Name,
        },
      ]);
    }

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
      schema = extractSchemaFromRuntimeType(routeParameter.RuntimeType, this.Validator);
    }

    if (this.isRuntimeType(routeParameter)) {
      result = this.fromRuntimeType(routeParameter, arg);

      // absent optional params are not validated - validator treats null / undefined data as failure
      if (schema && result !== null && result !== undefined) {
        this.Validator.validate(schema, result);
      }
    } else {
      hydrator = this.getHydrator(routeParameter);
      result = hydrator ? arg : this.tryExtractObject(arg, routeParameter);

      // absent optional params are not validated - validator treats null / undefined data as failure
      if (schema && result !== null && result !== undefined) {
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
    try {
      // TypedArray must be checked BEFORE isClass: a TypedArray instance's
      // constructor is `class TypedArray`, so isClass() reports true for it and
      // would (wrongly) try `new <instance>()`. Handle the typed-array case here.
      if (param.RuntimeType instanceof TypedArray) {
        const type = (param.RuntimeType as TypedArray<any>).Type as any;
        const arrData = _.isString(arg) ? JSON.parse(arg) : arg;
        if (arrData === null || arrData === undefined) {
          return [];
        }
        if (!Array.isArray(arrData)) {
          // A typed-array param requires a JSON array; a non-array value is a
          // client error (400), not an uncaught TypeError from .map (500).
          throw new InvalidArgument(`Parameter '${param.Name}' must be a JSON array`, param.Name);
        }
        return arrData.map((x: any) => new type(x));
      } else if (isClass(param.RuntimeType)) {
        return new (param.RuntimeType as any)(_.isString(arg) ? JSON.parse(arg) : arg);
      } else if (param.RuntimeType.name === 'Object' || param.RuntimeType.name === 'Array') {
        return _.isString(arg) ? JSON.parse(arg) : arg;
      }

      return arg;
    } catch (err) {
      if (err.constructor.name === 'SyntaxError') {
        throw new InvalidArgument(`Argument '${param.Name}' is invalid JSON. Reason: ${err.message}`, err);
      }

      // dont care others
      throw err;
    }
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
        // Only treat truly-absent values as undefined — `0` is a valid number
        // and must not be coerced away (JSON body can carry a literal 0).
        return arg === undefined || arg === null || arg === '' ? undefined : Number(arg);
      case 'BigInt':
        try {
          return BigInt(arg);
        } catch (err) {
          throw new InvalidArgument(`Argument '${param.Name}' is not a valid integer`, err);
        }
      case 'Boolean':
        // A JSON body can deliver a real boolean; return it as-is instead of
        // calling String.toLowerCase on it (which threw). Query/param values
        // arrive as strings and are matched case-insensitively.
        if (typeof arg === 'boolean') return arg;
        return arg ? arg === 1 || String(arg).toLowerCase() === 'true' : false;
      case 'Undefined':
        return undefined;
      case 'Null':
        return null;
      default:
        return new param.RuntimeType(_.isString(arg) ? JSON.parse(arg) : arg);
    }
  }
}
