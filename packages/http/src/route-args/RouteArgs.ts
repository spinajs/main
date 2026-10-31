import { DI, Autoinject, type TypedArray, isClass, isTypedArray } from '@spinajs/di';
import { ParameterType, IRouteParameter, IRouteCall, IRoute, Request } from './../interfaces.js';
import * as express from 'express';
import { ArgHydrator } from './ArgHydrator.js';
import { ArgInputFilter } from '../arg-input-filter.js';
import _ from 'lodash';
import { DataValidator, ValidationFailed } from '@spinajs/validation';
import { InvalidArgument } from '@spinajs/exceptions';
import { derivedValidatorOf, type DerivedArgCheck } from './manifest-schema.js';

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
  if (isTypedArray(runtimeType)) {
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
    // Filtered first, so an input filter that removes a required value fails the check below.
    if (arg !== null && arg !== undefined) {
      arg = await this.filterInput(arg, routeParameter, route);
    }

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
    let hydrator = null;
    const { schema, derived } = this.schemasOf(routeParameter, route);

    if (this.isRuntimeType(routeParameter)) {
      result = this.fromRuntimeType(routeParameter, arg);

      // absent optional params are not validated - validator treats null / undefined data as failure
      if (schema && result !== null && result !== undefined) {
        await this.Validator.validateAsync(schema, result);
      }
      // JSON Schema has no bigint
      if (derived && result !== null && result !== undefined && typeof result !== 'bigint') {
        derived(result);
      }
    } else {
      hydrator = this.getHydrator(routeParameter);

      // A hydrator reads its own wire format, which the schema derived from the hydrated type does not describe.
      if (derived && !hydrator && arg !== null && arg !== undefined) {
        arg = derived(this.parseJsonArg(arg, routeParameter));
      }

      result = hydrator ? arg : this.tryExtractObject(arg, routeParameter);

      // absent optional params are not validated - validator treats null / undefined data as failure
      if (schema && result !== null && result !== undefined) {
        await this.Validator.validateAsync(schema, result);
      }

      if (hydrator) {
        result = await this.tryHydrateObject(result, routeParameter, hydrator);
      }
    }

    return result;
  }

  /**
   * The explicit schema ( `route.Schema`, the decorator's, the class `@Schema` ) wins. Without one, the schema the
   * manifest derived from the parameter type is checked against the request value ( `derived` ), next to the
   * framework's default for scalars ( `RouteParamSchema` ).
   */
  protected schemasOf(param: IRouteParameter, route: IRoute): { schema: any; derived?: DerivedArgCheck } {
    if (route.Schema && route.Schema[param.Name]) {
      return { schema: route.Schema[param.Name] };
    }
    if (param.Schema) {
      return { schema: param.Schema };
    }

    const classSchema = param.RouteParamSchema ? null : extractSchemaFromRuntimeType(param.RuntimeType, this.Validator);
    return { schema: param.RouteParamSchema || classSchema, derived: classSchema ? undefined : derivedValidatorOf(param) };
  }

  /** Checks a whole request part ( `@QueryField()`, `@BodyField()`, ... ) against its derived schema, unless its class has a `@Schema`. */
  protected checkDerived<T>(value: T, param: IRouteParameter): T {
    const derived = derivedValidatorOf(param);
    if (!derived || value === null || value === undefined || extractSchemaFromRuntimeType(param.RuntimeType, this.Validator)) {
      return value;
    }

    // Coercion rewrites what it checks; other arguments and middlewares read req.params and req.headers as sent.
    const checked = _.isPlainObject(value) ? ({ ...value } as T) : value;
    return derived(checked) as T;
  }

  /** The value as `tryExtractObject` reads it, before it builds the class: what the client sent, JSON parsed. */
  protected parseJsonArg(arg: unknown, param: IRouteParameter): unknown {
    const type = param.RuntimeType as { name?: unknown } | null | undefined;
    const parsed = isTypedArray(type) || isClass(type) || type?.name === 'Object' || type?.name === 'Array';
    if (!parsed || !_.isString(arg)) {
      return arg;
    }

    try {
      return JSON.parse(arg) as unknown;
    } catch {
      // The parser message quotes the input.
      throw new InvalidArgument(`Argument '${param.Name}' is invalid JSON`, param.Name);
    }
  }

  protected async filterInput(arg: unknown, routeParameter: IRouteParameter, route?: IRoute): Promise<unknown> {
    const filters = (await DI.resolve(Array.ofType(ArgInputFilter))) as ArgInputFilter[];
    if (filters.length === 0) {
      return arg;
    }

    // Filters see JSON objects and arrays parsed, and their output goes on as a string again: hydrators
    // that parse their input themselves keep getting what they got before. Any other string (an ISO date
    // for DateTimeHydrator, bad JSON) reaches the filters and the hydrator as it came.
    let input = arg;
    let parsedFromString = false;
    if (_.isString(input) && !this.isRuntimeType(routeParameter)) {
      try {
        const parsed = JSON.parse(input);
        if (parsed !== null && typeof parsed === 'object') {
          input = parsed;
          parsedFromString = true;
        }
      } catch {}
    }

    for (const filter of filters) {
      input = await filter.filter(input, routeParameter, route);
    }

    return parsedFromString && input !== null && typeof input === 'object' ? JSON.stringify(input) : input;
  }

  protected async tryHydrateObject(arg: any, route: IRouteParameter, hydrator: any) {
    const hInstance = await DI.resolve<ArgHydrator>(hydrator.hydrator, hydrator.options);
    return await hInstance.hydrate(arg, route);
  }

  protected getHydrator(param: IRouteParameter) {
    let hydrator = null;
    if (isTypedArray(param.RuntimeType)) {
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
      if (isTypedArray(param.RuntimeType)) {
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
      if (err instanceof Error && err.constructor.name === 'SyntaxError') {
        // The parser message quotes the input.
        throw new InvalidArgument(`Argument '${param.Name}' is invalid JSON`, param.Name);
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
        } catch {
          throw new InvalidArgument(`Argument '${param.Name}' is not a valid integer`, param.Name);
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
