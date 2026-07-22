import { Constructor, DI } from '@spinajs/di';
import { RouteType, IRouteParameter, ParameterType, IControllerDescriptor, BasePolicy, RouteMiddleware, IRoute, IUploadOptions, UuidVersion, IFormOptions, HttpAcceptHeaders, IController, HTTP_STATUS_CODE } from './interfaces.js';
import { ArgHydrator } from './route-args/ArgHydrator.js';
import { ROUTE_ARG_SCHEMA } from './schemas/RouteArgsSchemas.js';
import { Options as CsvParseOptions } from 'csv-parse';
import { toArray } from '@spinajs/util';

import { RequestTypeRouteArgs } from './route-args/RequestFields.js';
import { BadRequest } from '@spinajs/exceptions';
import * as express from 'express';


export const CONTROLLED_DESCRIPTOR_SYMBOL = Symbol('CONTROLLER_SYMBOL');

function Controller(callback: (controller: IControllerDescriptor, target: any, propertyKey: symbol | string, indexOrDescriptor: number | PropertyDescriptor) => void) {
  return (target: any, propertyKey?: string | symbol, indexOrDescriptor?: number | PropertyDescriptor) => {
    let metadata: IControllerDescriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, target.prototype || target);
    if (!metadata) {
      metadata = {
        BasePath: null,
        Middlewares: [],
        Policies: [],
        Routes: new Map<string, IRoute>(),
        // Capture the controller's source file from the V8 stack the first
        // time a route decorator runs on this class. The first frame outside
        // this module / common transpiler shims is the controller source —
        // exactly what ControllersCache needs when the controller was added
        // through DI rather than the file scan.
        SourceFile: captureControllerSourceFile(),
      };

      Reflect.defineMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, metadata, target.prototype || target);
    }

    if (callback) {
      callback(metadata, target, propertyKey!, indexOrDescriptor!);
    }
  };
}

/**
 * Walk the current V8 stack and return the absolute path of the first frame
 * that is NOT inside this decorators module or a common transpiler helper.
 * That frame is the user's controller source file. Works equally for CJS
 * (path frames like `at ... (C:\\foo\\bar.js:12:3)`) and ESM (URL frames like
 * `at ... (file:///C:/foo/bar.js:12:3)`).
 */
function captureControllerSourceFile(): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;

  const lines = stack.split('\n');
  const skipMarkers = [
    'decorators.ts',
    'decorators.js',
    'tslib',
    'reflect-metadata',
    '__decorate',
    '__esDecorate',
    'node:internal',
  ];

  for (const line of lines) {
    if (skipMarkers.some(m => line.includes(m))) continue;
    // Match `(path:line:col)` or bare `path:line:col` at the end of the frame.
    const m = line.match(/\(([^()]+):\d+:\d+\)\s*$/) || line.match(/at\s+([^\s()]+):\d+:\d+\s*$/);
    if (!m) continue;

    let file = m[1];
    if (file.startsWith('file://')) {
      // Strip ESM file:// URL scheme. Windows: file:///C:/foo → C:/foo.
      try {
        file = decodeURIComponent(file.replace(/^file:\/\/\/?/, ''));
        // Normalize Windows drive letter forms (`/C:/...` → `C:/...`).
        if (/^[A-Za-z]:/.test(file)) {
          // already a drive-letter path
        } else if (file.startsWith('/')) {
          // POSIX absolute path stays as-is
        }
      } catch {
        // fall through with the raw match
      }
    }
    return file;
  }
  return undefined;
}

export function Route(callback: (controller: IControllerDescriptor, route: IRoute, target: any, propertyKey?: string | symbol, indexOrDescriptor?: number | PropertyDescriptor) => void) {
  return Controller((metadata: IControllerDescriptor, target: any, propertyKey: string | symbol, indexOrDescriptor: number | PropertyDescriptor) => {
    let route: IRoute | null = null;
    if (propertyKey) {
      if (metadata.Routes.has(propertyKey)) {
        route = metadata.Routes.get(propertyKey)!;
      } else {
        route = {
          InternalType: RouteType.UNKNOWN,
          Method: propertyKey,
          Middlewares: [],
          Parameters: new Map<number, IRouteParameter>(),
          Path: '',
          Policies: [],
          Type: RouteType.UNKNOWN,
          Options: null,
          Schema: null,
        };
      }

      metadata.Routes.set(propertyKey, route);
    }

    if (callback) {
      callback(metadata, route!, target, propertyKey, indexOrDescriptor);
    }
  });
}

/**
 * Ugly hack to specify type for route args. Mostly used to define type of array, becouse typescript does not
 * have information about this.
 */
export function Type(type: any) {
  return Route((_: IControllerDescriptor, route: IRoute, _target: any, _propertyKey: string | symbol, index: number | PropertyDescriptor ) => {

    if(typeof index !== 'number'){
      throw new Error(`@Type decorator can be used only on method parameters. Invalid usage on ${_propertyKey.toString()} of ${_target.constructor.name}`);
    }

    if (route.Parameters.has(index)) {
      route.Parameters.get(index)!.RuntimeType = type;
    } else {
      const param: IRouteParameter = {
        Index: index,
        Name: '',
        RuntimeType: type,
        RouteParamSchema: '',
        Options: null,
        Type: '' as any,
      };

      route.Parameters.set(index, param);
    }
  });
}

export function Parameter(type: ParameterType | string, schema?: any, options?: any) {
  return (_: IControllerDescriptor, route: IRoute, target: any, propertyKey?: string | symbol, index?: number | PropertyDescriptor) => {

    if(propertyKey === undefined){
      throw new Error(`propertyKey is required for @Parameter decorator. Invalid usage on ${target.constructor.name}`);
    }

    if(typeof index !== 'number'){
      throw new Error(`@Parameter decorator can be used only on method parameters. Invalid usage on ${propertyKey.toString()} of ${target.constructor.name}`);
    }

    const rType = Reflect.getMetadata('design:paramtypes', target.prototype || target, propertyKey)[index];

    let tSchema = null;

    switch (rType.name) {
      case 'Number':
        tSchema = ROUTE_ARG_SCHEMA.Number;
        break;
      case 'String':
        tSchema = ROUTE_ARG_SCHEMA.String;
        break;
      case 'Boolean':
        tSchema = ROUTE_ARG_SCHEMA.Boolean;
    }

    if (route.Parameters.has(index)) {
      const p = route.Parameters.get(index);

      if(!p){
        throw new Error(`Failed to get parameter metadata for parameter at index ${index} of method ${String(propertyKey)} in controller ${target.constructor.name}`);
      }
      
      p.Type = type;
      p.Options = options;
      p.RouteParamSchema = tSchema;
      p.Schema = schema;
    } else {
      const param: IRouteParameter = {
        Index: index,
        Name: '',
        RuntimeType: rType,
        RouteParamSchema: tSchema,
        Schema: schema,
        Options: options,
        Type: type,
      };

      route.Parameters.set(index, param);
    }
  };
}

/**
 * Tells controller how to fill up incoming parameters in controller actions
 *
 * @param hydrator - hydrator class that will fill up incoming argument
 * @param options - additional options passed to hydrator
 */
export function Hydrator(hydrator: Constructor<ArgHydrator>, ...options: any[]) {
  return (target: any) => {
    if (!Reflect.getMetadata('custom:arg_hydrator', target)) {
      Reflect.defineMetadata(
        'custom:arg_hydrator',
        {
          hydrator,
          options,
        },
        target,
      );
    }
  };
}

export function HandleException(exception: Constructor<Error> | Constructor<Error>[]) {
  return (target: any) => {
    toArray(exception).forEach((e) => {
      DI.register(target).asMapValue('__http_error_map__', e.name);
    });
  };
}

/**
 *
 * @param policy - policy to set. Could be type or path in configuration to with policy to inject ( eg. metrics.auth.policy )
 * @param options
 * @returns
 */
export function Policy(policy: Constructor<BasePolicy> | string, ...options: any[]) {
  return Route((controller: IControllerDescriptor, route: IRoute, _: any, _1: string | symbol, _2: number | PropertyDescriptor) => {
    const pDesc = {
      Options: options,
      Type: policy,
    };

    if (route) {
      route.Policies.push(pDesc);
    } else {
      controller.Policies.push(pDesc);
    }
  });
}

export function Middleware(policy: Constructor<RouteMiddleware>, ...options: any[]) {
  return Route((controller: IControllerDescriptor, route: IRoute, _: any, _1: string | symbol, _2: number | PropertyDescriptor) => {
    const pDesc = {
      Options: options,
      Type: policy,
    };

    if (route) {
      route.Middlewares.push(pDesc);
    } else {
      controller.Middlewares.push(pDesc);
    }
  });
}

/**
 * 
 * Checks if incoming request is proper type ( accepts proper content type ) and throws BadRequest if not
 * 
 * @param accepts 
 * @returns 
 */
export function Accepts(accepts: HttpAcceptHeaders) {
  return Middleware(class implements RouteMiddleware {
    public isEnabled(): boolean {
      return true;
    }
    public async onBefore(req: express.Request, res: express.Response, route: IRoute, _controller: IController): Promise<void> {
      const paramExtract = await DI.resolve(RequestTypeRouteArgs);
      const { Args } = await paramExtract.extract(null as any, null as any, null as any, req, res, route);

      if (!(Args & accepts)) {
        throw new BadRequest(`Accepted content type ${accepts} is not supported`, HTTP_STATUS_CODE.NOT_ACCEPTABLE);
      }

    }
    public async onResponse(): Promise<void> {
    }
    public async onAfter(): Promise<void> {
    }
  });
}

export function BasePath(path: string) {
  return Controller((metadata: IControllerDescriptor) => {
    metadata.BasePath = path;
  });
}

export function FromDI() {
  return Route(Parameter(ParameterType.FromDi));
}

/**
 * Gets whole body field
 * @returns body field of request
 */
export function BodyField() {
  return Route(Parameter(ParameterType.BodyField));
}

export function AcceptType() {
  return Route(Parameter(ParameterType.RequestType));
}

/**
 * Gets all headers field ot type express.IncommingHttpHeaders
 * @returns headers field of request
 */
export function HeadersField() {
  return Route(Parameter(ParameterType.Headers));
}

/**
 * Get whole query field from request.
 *
 * @returns whole request field of request
 */
export function QueryField() {
  return Route(Parameter(ParameterType.QueryField));
}

/**
 * Get whole params field from request.
 * @returns whole request field of request
 */
export function ParamField() {
  return Route(Parameter(ParameterType.ParamField));
}

/**
 * Route parameter taken from query string eg. route?id=1
 *
 * @param schema - parameter json schema for optional validation
 */
export function Query(schema?: any, options?: { required?: boolean }) {
  return Route(Parameter(ParameterType.FromQuery, schema, options));
}

/**
 * Route parameter taken from message body (POST)
 *
 * @param schema - parameter json schema for optional validation
 */
export function Body(options?: { required?: boolean }) {
  return Route(Parameter(ParameterType.FromBody, null, options));
}

/**
 * Route parameter taken from url parameters eg. route/:id
 *
 * @param schema - parameter json schema for optional validation
 */
export function Param(schema?: any, options?: { required?: boolean }) {
  return Route(Parameter(ParameterType.FromParams, schema, options));
}

/**
 * Gets parameter from request header. If not keyname is provided
 * variable name is used as header key name
 *
 * @param keyName - header key name ( optional )
 * @param schema - schema for validation ( optional )
 * @returns
 */
export function Header(keyName?: string, schema?: any, options?: { required?: boolean }) {
  return Route(Parameter(ParameterType.FromHeader, schema, { key: keyName, ...options }));
}

/**
 *
 * Parameter as file
 *
 * @param options - upload options
 */
export function File(options?: IUploadOptions) {
  return Route(Parameter(ParameterType.FromFile, null, options));
}

/**
 * Multiple uploaded files for a form field, always returned as an array
 * (even when a single file is sent). Semantic alias over {@link File}.
 *
 * @param options - upload options
 */
export function Files(options?: IUploadOptions) {
  return Route(Parameter(ParameterType.FromFile, null, { ...(options ?? {}), asArray: true }));
}

/**
 * Client IP address (as resolved by the RealIp middleware).
 */
export function Ip() {
  return Route(Parameter(ParameterType.Ip, null));
}

/**
 * Per-request correlation id (matches the `x-request-id` response header).
 */
export function RequestId() {
  return Route(Parameter(ParameterType.RequestId, null));
}

/**
 * `User-Agent` request header.
 */
export function UserAgent() {
  return Route(Parameter(ParameterType.UserAgent, null));
}

/**
 * `Referer` (or `Referrer`) request header.
 */
export function Referer() {
  return Route(Parameter(ParameterType.Referer, null));
}

/**
 * Raw request body Buffer, for webhook signature verification. Captured for
 * JSON requests via the express.json `verify` hook.
 */
export function RawBody() {
  return Route(Parameter(ParameterType.RawBody, null));
}

/**
 * Parses an XML request body into an object.
 *
 * @param options - fast-xml-parser options (optional)
 */
export function FromXml(options?: any) {
  return Route(Parameter(ParameterType.FromXml, null, options));
}

/**
 * Data taken from cvs file that is uploaded. Actions receives parsed data
 *
 * @param options - upload options
 * @param cvsParseOptions - cvs parser options
 * @param schema - optional schema for data validation
 */
export function CsvFile(cvsParseOptions?: CsvParseOptions) {
  return Route(Parameter(ParameterType.FromCSV, null, cvsParseOptions));
}

/**
 * Data taken from cvs file that is uploaded. Actions receives parsed data
 *
 * @param options - upload options
 * @param schema - optional schema for data validation
 */
export function JsonFile(options?: IUploadOptions) {
  return Route(Parameter(ParameterType.FromJSONFile, null, options));
}

/**
 *
 * Parameter taken from form data (multipart-form)
 *
 * @param options - upload options
 */
export function Form(options?: IFormOptions) {
  return Route(Parameter(ParameterType.FromForm, options));
}

/**
 *
 * Parameter taken from form data (multipart-form)
 *
 * @param options - upload options
 */
export function FormField(schema?: any, options?: IFormOptions) {
  return Route(Parameter(ParameterType.FormField, schema, options));
}

/**
 *
 * Shortcut for parameter as autoincrement primary key ( number greater than 0)
 *
 */
export function PKey(type?: ParameterType) {
  return Route(Parameter(type ? type : ParameterType.FromParams, { type: 'number', minimum: 0 }));
}

/**
 *
 * Shortcut for parameter as uuid primary key ( string with 32 length )
 *
 */
export function Uuid(type?: ParameterType, version?: UuidVersion) {
  return Route(
    Parameter(
      type ? type : ParameterType.FromParams,
      { type: 'string', minLength: 36, maxLength: 36, pattern: '^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$' },
      {
        version: version ?? UuidVersion.v4,
      },
    ),
  );
}

/**
 *
 *  Express request
 *
 */
export function Req() {
  return Route(Parameter(ParameterType.Req, null));
}

/**
 *
 *  Express res
 *
 */
export function Res() {
  return Route(Parameter(ParameterType.Res, null));
}

/**
 *
 * Parameter taken from model
 *
 * @param options - upload options
 */
export function Model(model: Constructor<any>) {
  return Route(Parameter(ParameterType.FromModel, null, { type: model }));
}

/**
 *
 * Parameter taken from coockie
 *
 * @param options - upload options
 */
export function Cookie(secure = false) {
  return Route(Parameter(ParameterType.FromCookie, { type: 'string' }, { secure }));
}

/**
 * Creates HEAD http request method
 * @param path - url path to method eg. /foo/bar/:id
 */
export function Head(path?: string, schema?: any) {
  return Route((_, route: IRoute) => {
    route.Type = RouteType.HEAD;
    route.InternalType = RouteType.HEAD;
    route.Path = path;
    route.Schema = schema;
  });
}

/**
 * Creates PATCH http request method
 * @param path - url path to method eg. /foo/bar/:id
 */
export function Patch(path?: string, schema?: any) {
  return Route((_, route: IRoute) => {
    route.Type = RouteType.PATCH;
    route.InternalType = RouteType.PATCH;
    route.Path = path;
    route.Schema = schema;
  });
}

/**
 * Creates DELETE http request method
 * @param path - url path to method eg. /foo/bar/:id
 * @param routeName - route name visible in api. If undefined, method name is taken
 */
export function Del(path?: string, schema?: any) {
  return Route((_, route: IRoute) => {
    route.Type = RouteType.DELETE;
    route.InternalType = RouteType.DELETE;
    route.Path = path;
    route.Schema = schema;
  });
}

/**
 * Creates PUT http request method
 * @param path - url path to method eg. /foo/bar/:id
 */
export function Put(path?: string, schema?: any) {
  return Route((_, route: IRoute) => {
    route.Type = RouteType.PUT;
    route.InternalType = RouteType.PUT;
    route.Path = path;
    route.Schema = schema;
  });
}

/**
 * Creates GET http request method
 * @param path - url path to method eg. /foo/bar/:id
 */
export function Get(path?: string, schema?: any) {
  return Route((_, route: IRoute) => {
    route.Type = RouteType.GET;
    route.InternalType = RouteType.GET;
    route.Path = path;
    route.Schema = schema;
  });
}

/**
 * Creates POST http request method
 *
 * @param path - url path to method eg. /foo/bar
 */
export function Post(path?: string, schema?: any) {
  return Route((_, route: IRoute) => {
    route.Type = RouteType.POST;
    route.InternalType = RouteType.POST;
    route.Path = path;
    route.Schema = schema;
  });
}
