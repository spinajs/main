import { ClassInfo } from '@spinajs/di';
import { BaseController, IRoute, IRouteParameter, ParameterType, RouteType } from '@spinajs/http';
import {
  IOpenApiDocument,
  IOpenApiOperation,
  IOpenApiParameter,
  IOpenApiRequestBody,
  IOpenApiSchema,
  IOpenApiTag,
  ISwaggerCacheEntry,
  ISwaggerConfig,
  IMethodDocumentation,
} from './interfaces.js';

/**
 * Set of ParameterType values that map to internal framework params (not API params).
 * These are skipped when generating OpenAPI parameters.
 */
const INTERNAL_PARAMS = new Set<string>([
  ParameterType.Req,
  ParameterType.Res,
  ParameterType.FromDi,
  ParameterType.FromSession,
  ParameterType.RequestType,
  'ArgAsRequest',
  'ArgAsResponse',
  'FromDi',
  'FromSession',
  'RequestTypeRouteArgs',
]);

/**
 * ParameterType values that represent request body data
 */
const BODY_PARAMS = new Set<string>([
  ParameterType.FromBody,
  ParameterType.BodyField,
  ParameterType.FromForm,
  ParameterType.FormField,
  ParameterType.FromModel,
  ParameterType.FromFile,
  ParameterType.FromCSV,
  ParameterType.FromJSONFile,
  'FromBody',
  'BodyFieldRouteArgs',
  'FromForm',
  'FromFormField',
  'FromModel',
  'FromFile',
  'FromCSV',
  'FromJSONFile',
]);

/**
 * Mapping from ParameterType to OpenAPI 'in' location
 */
const PARAM_LOCATION_MAP: Record<string, 'query' | 'path' | 'header' | 'cookie'> = {
  FromQuery: 'query',
  QueryFieldRouteArgs: 'query',

  FromParams: 'path',
  ParamFieldRouteArgs: 'path',

  FromHeader: 'header',
  HeadersFieldRouteArgs: 'header',

  FromCookie: 'cookie',
};

export class OpenApiBuilder {
  private config: ISwaggerConfig;
  private document: IOpenApiDocument;
  private tags: Map<string, IOpenApiTag> = new Map();

  constructor(config: ISwaggerConfig) {
    this.config = config;
    this.document = {
      openapi: '3.0.3',
      info: {
        title: config.title || 'API Documentation',
        version: config.version || '1.0.0',
        description: config.description,
      },
      servers: config.servers?.map((s) => ({ url: s.url, description: s.description })),
      paths: {},
      components: {},
      tags: [],
    };

    if (config.securitySchemes) {
      this.document.components = {
        securitySchemes: config.securitySchemes,
      };
    }

    if (config.security) {
      this.document.security = config.security;
    }
  }

  /**
   * Add a controller's routes to the OpenAPI document.
   */
  public addController(
    controller: ClassInfo<BaseController>,
    docCache: ISwaggerCacheEntry,
  ): void {
    const descriptor = controller.instance.Descriptor;
    if (!descriptor) return;

    const basePath = descriptor.BasePath || '';
    const controllerName = controller.name.replace(/Controller$/, '');

    // Register tag from class documentation or controller name
    const tagName = docCache.classTags?.[0] || controllerName;
    if (!this.tags.has(tagName)) {
      this.tags.set(tagName, {
        name: tagName,
        description: docCache.classDescription,
      });
    }

    for (const [methodName, route] of descriptor.Routes) {
      const methodNameStr = methodName as string;
      const methodDoc = docCache.methods[methodNameStr];
      const fullPath = this.buildPath(basePath, route.Path, route.Method);
      const httpMethod = this.mapRouteType(route.Type);

      if (!httpMethod) continue;

      const operation = this.buildOperation(
        controller.name,
        methodNameStr,
        route,
        methodDoc,
        tagName,
      );

      if (!this.document.paths[fullPath]) {
        this.document.paths[fullPath] = {};
      }

      this.document.paths[fullPath][httpMethod] = operation;
    }
  }

  /**
   * Build the final OpenAPI document.
   */
  public build(): IOpenApiDocument {
    this.document.tags = Array.from(this.tags.values());
    return this.document;
  }

  /**
   * Build the full URL path for a route.
   */
  private buildPath(basePath: string, routePath: string | undefined, methodName: string): string {
    let path = '';

    const prefix = this.config.basePath ? `/${this.config.basePath}` : '';

    if (routePath) {
      if (routePath === '/') {
        path = `/${basePath}`;
      } else if (basePath === '/') {
        path = `/${routePath}`;
      } else {
        path = `/${basePath}/${routePath}`;
      }
    } else {
      path = `/${basePath}/${methodName}`;
    }

    // Convert Express-style params (:id) to OpenAPI style ({id})
    path = path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');

    return `${prefix}${path}`;
  }

  /**
   * Map SpineJS RouteType to OpenAPI HTTP method string.
   */
  private mapRouteType(type: RouteType): string | null {
    switch (type) {
      case RouteType.GET:
      case RouteType.FILE:
        return 'get';
      case RouteType.POST:
        return 'post';
      case RouteType.PUT:
        return 'put';
      case RouteType.DELETE:
        return 'delete';
      case RouteType.PATCH:
        return 'patch';
      case RouteType.HEAD:
        return 'head';
      default:
        return null;
    }
  }

  /**
   * Build an OpenAPI operation from a route and its documentation.
   */
  private buildOperation(
    controllerName: string,
    methodName: string,
    route: IRoute,
    methodDoc: IMethodDocumentation | undefined,
    tagName: string,
  ): IOpenApiOperation {
    const operation: IOpenApiOperation = {
      operationId: `${controllerName}_${methodName}`,
      tags: methodDoc?.tags || [tagName],
      summary: methodDoc?.summary,
      description: methodDoc?.description,
      deprecated: methodDoc?.deprecated,
      parameters: [],
      responses: this.buildResponses(methodDoc),
    };

    const bodyParams: { param: IRouteParameter; doc?: { name: string; description?: string; type?: string } }[] = [];

    // Process route parameters
    for (const [, param] of route.Parameters) {
      if (INTERNAL_PARAMS.has(param.Type as string)) {
        continue;
      }

      const paramDoc = methodDoc?.params?.[param.Name];

      if (BODY_PARAMS.has(param.Type as string)) {
        bodyParams.push({ param, doc: paramDoc });
        continue;
      }

      const location = PARAM_LOCATION_MAP[param.Type as string];
      if (location) {
        const apiParam = this.buildParameter(param, location, paramDoc);
        operation.parameters!.push(apiParam);
      }
    }

    // Build request body from body params
    if (bodyParams.length > 0) {
      operation.requestBody = this.buildRequestBody(bodyParams, route);
    }

    // Add examples to request body if available
    if (methodDoc?.examples && operation.requestBody) {
      const content = operation.requestBody.content['application/json'];
      if (content) {
        content.examples = {};
        methodDoc.examples.forEach((ex, i) => {
          const key = ex.name || `example_${i + 1}`;
          content.examples![key] = {
            summary: ex.name,
            description: ex.description,
            value: this.tryParseJson(ex.value),
          };
        });
      }
    }

    // Remove empty parameters array
    if (operation.parameters!.length === 0) {
      delete operation.parameters;
    }

    return operation;
  }

  /**
   * Build an OpenAPI parameter from route parameter info.
   */
  private buildParameter(
    param: IRouteParameter,
    location: 'query' | 'path' | 'header' | 'cookie',
    doc?: { name: string; description?: string; type?: string },
  ): IOpenApiParameter {
    return {
      name: param.Name || `param_${param.Index}`,
      in: location,
      description: doc?.description,
      required: location === 'path', // Path params are always required
      schema: this.inferSchema(param.RuntimeType, doc?.type),
    };
  }

  /**
   * Build an OpenAPI request body from body-type parameters.
   */
  private buildRequestBody(
    bodyParams: { param: IRouteParameter; doc?: { name: string; description?: string; type?: string } }[],
    _route: IRoute,
  ): IOpenApiRequestBody {
    // Check if any param is a file upload
    const hasFile = bodyParams.some(
      (bp) => bp.param.Type === ParameterType.FromFile || bp.param.Type === 'FromFile',
    );

    const contentType = hasFile ? 'multipart/form-data' : 'application/json';

    // If there's a single body param with a model type, use it directly
    if (bodyParams.length === 1 && !hasFile) {
      const bp = bodyParams[0];
      return {
        description: bp.doc?.description,
        required: true,
        content: {
          [contentType]: {
            schema: this.inferSchema(bp.param.RuntimeType, bp.doc?.type),
          },
        },
      };
    }

    // Multiple body params → build an object schema
    const properties: Record<string, IOpenApiSchema> = {};
    for (const bp of bodyParams) {
      const name = bp.param.Name || `param_${bp.param.Index}`;
      properties[name] = {
        ...this.inferSchema(bp.param.RuntimeType, bp.doc?.type),
        description: bp.doc?.description,
      };
    }

    return {
      required: true,
      content: {
        [contentType]: {
          schema: {
            type: 'object',
            properties,
          },
        },
      },
    };
  }

  /**
   * Build response definitions from JSDoc @returns documentation.
   */
  private buildResponses(methodDoc: IMethodDocumentation | undefined): Record<string, { description: string; content?: Record<string, { schema?: IOpenApiSchema }> }> {
    const responses: Record<string, { description: string; content?: Record<string, { schema?: IOpenApiSchema }> }> = {};

    if (methodDoc?.returns) {
      responses['200'] = {
        description: methodDoc.returns.description || 'Successful response',
        content: {
          'application/json': {
            schema: methodDoc.returns.type ? this.inferSchemaFromString(methodDoc.returns.type) : { type: 'object' },
          },
        },
      };
    } else {
      responses['200'] = {
        description: 'Successful response',
      };
    }

    // Always add common error responses
    responses['400'] = { description: 'Bad Request' };
    responses['401'] = { description: 'Unauthorized' };
    responses['403'] = { description: 'Forbidden' };
    responses['404'] = { description: 'Not Found' };
    responses['500'] = { description: 'Internal Server Error' };

    return responses;
  }

  /**
   * Infer an OpenAPI schema from a TypeScript runtime type.
   */
  private inferSchema(runtimeType: any, docType?: string): IOpenApiSchema {
    if (docType) {
      return this.inferSchemaFromString(docType);
    }

    if (!runtimeType) {
      return { type: 'string' };
    }

    // Handle primitive constructors
    if (runtimeType === String) return { type: 'string' };
    if (runtimeType === Number) return { type: 'number' };
    if (runtimeType === Boolean) return { type: 'boolean' };
    if (runtimeType === Array) return { type: 'array', items: { type: 'string' } };
    if (runtimeType === Object) return { type: 'object' };

    // Handle class types (DTO, Model classes) - reference by name
    if (typeof runtimeType === 'function' && runtimeType.name) {
      return { type: 'object', description: `${runtimeType.name}` };
    }

    return { type: 'string' };
  }

  /**
   * Infer schema from a JSDoc type string like {string}, {number}, {MyDto}
   */
  private inferSchemaFromString(typeStr: string): IOpenApiSchema {
    const cleaned = typeStr.replace(/[{}]/g, '').trim();

    switch (cleaned.toLowerCase()) {
      case 'string':
        return { type: 'string' };
      case 'number':
      case 'integer':
        return { type: 'number' };
      case 'boolean':
        return { type: 'boolean' };
      case 'object':
        return { type: 'object' };
      case 'array':
        return { type: 'array', items: { type: 'string' } };
      default:
        // Could be a DTO/Model class name
        return { type: 'object', description: cleaned };
    }
  }

  /**
   * Try to parse a string as JSON, return as-is if not valid JSON.
   */
  private tryParseJson(value: string | undefined): any {
    if (!value) return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
}
