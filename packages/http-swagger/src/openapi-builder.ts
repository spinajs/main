import { Autoinject, ClassInfo, TypedArray } from '@spinajs/di';
import { BaseController, IRoute, IRouteParameter, ParameterType, RouteType } from '@spinajs/http';
import { SCHEMA_SYMBOL, SchemaProvider } from '@spinajs/validation';
import { safeParse } from '@spinajs/util';
import {
  IOpenApiDocument,
  IOpenApiOperation,
  IOpenApiParameter,
  IOpenApiRequestBody,
  IOpenApiResponse,
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
  // orm-http: @AsModel — alias for FromBody (creates instance from request body)
  'AsDbModel',
]);

/**
 * Body params that are parsed from a multipart/form upload at runtime (see
 * @spinajs/http FromForm route-args). Any of these on a route means the
 * request body is multipart/form-data, not application/json.
 */
const MULTIPART_BODY_PARAMS = new Set<string>([
  ParameterType.FromFile, 'FromFile',
  ParameterType.FromForm, 'FromForm',
  ParameterType.FormField, 'FromFormField',
  ParameterType.FromCSV, 'FromCSV',
  ParameterType.FromJSONFile, 'FromJSONFile',
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

/**
 * Reusable response component names per HTTP status code. Drives the
 * `#/components/responses/<Name>` $ref emitted for documented error responses.
 */
const STANDARD_RESPONSE_NAMES: Record<string, string> = {
  '400': 'BadRequest',
  '401': 'Unauthorized',
  '403': 'Forbidden',
  '404': 'NotFound',
  '405': 'MethodNotAllowed',
  '406': 'NotAcceptable',
  '409': 'Conflict',
  '413': 'PayloadTooLarge',
  '422': 'ValidationError',
  '500': 'ServerError',
};

/**
 * Default human-readable descriptions for the reusable responses, used when the
 * JSDoc didn't supply one.
 */
const STANDARD_RESPONSE_DESCRIPTIONS: Record<string, string> = {
  '400': 'Bad request — the server could not understand the request',
  '401': 'Unauthorized — valid authentication required',
  '403': 'Forbidden — caller lacks the required permission',
  '404': 'Not found — the requested resource does not exist',
  '405': 'Method not allowed for this resource',
  '406': 'Not acceptable — cannot produce a response matching the Accept header',
  '409': 'Conflict — request conflicts with current resource state',
  '413': 'Payload too large',
  '422': 'Validation error — request body failed schema validation',
  '500': 'Internal server error',
};

export class OpenApiBuilder {
  private config: ISwaggerConfig;
  private document: IOpenApiDocument;
  private tags: Map<string, IOpenApiTag> = new Map();
  private registeredResponses: Set<string> = new Set();
  private registeredComponents: Set<string> = new Set();
  private errorSchemaRegistered = false;
  private registeredPolicies: Set<string> = new Set();
  private policySectionEntries: string[] = [];
  private infoDescriptionBase: string = '';

  @Autoinject(SchemaProvider)
  protected SchemaProviders!: SchemaProvider[];

  constructor(config: ISwaggerConfig) {
    this.config = config;
    this.infoDescriptionBase = config.description ?? '';
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
    const descriptor = controller.instance?.Descriptor;
    if (!descriptor) return;

    // Mirror the runtime BasePath resolution (BaseController.BasePath): when no
    // @BasePath decorator is present the routes mount under the lowercased class
    // name (e.g. UsersController -> /userscontroller/...). Documenting an empty
    // basePath here produced wrong URLs for every undecorated controller.
    const basePath = descriptor.BasePath || controller.instance!.constructor.name.toLowerCase();
    const controllerName = controller.name.replace(/Controller$/, '');

    // Register tag from class documentation or controller name
    const tagName = docCache.classTags?.[0] || controllerName;
    if (!this.tags.has(tagName)) {
      this.tags.set(tagName, {
        name: tagName,
        description: docCache.classDescription,
      });
    }

    // RBAC metadata (from rbac-http @Resource / @Permission) — accessed via the
    // global Symbol.for('ACL_CONTROLLER_DESCRIPTOR_SYMBOL') so http-swagger
    // doesn't depend on rbac-http.
    const rbac = this.readRbacDescriptor(controller.instance);

    for (const [methodName, route] of descriptor.Routes) {
      const methodNameStr = methodName as string;
      const methodDoc = docCache.methods[methodNameStr];
      const fullPath = this.buildPath(basePath, route.Path, route.Method as string);
      const httpMethod = this.mapRouteType(route.Type);

      if (!httpMethod) continue;

      const operation = this.buildOperation(
        controller.name,
        methodNameStr,
        route,
        methodDoc,
        tagName,
      );

      this.applyRbac(operation, rbac, methodNameStr);
      this.applyPolicies(operation, docCache, methodNameStr);

      if (!this.document.paths[fullPath]) {
        this.document.paths[fullPath] = {};
      }

      this.document.paths[fullPath][httpMethod] = operation;
    }
  }

  /**
   * Surface policy information on an operation:
   *   - merge controller-level and route-level policies (controller policies run first)
   *   - vendor extension `x-policies` for tooling
   *   - human-readable line appended to `description`; each policy links to the
   *     reusable "Policies" section appended to `info.description`
   *
   * The JSDoc descriptions for each unique policy are registered once on the
   * document via `registerPolicyReference()`.
   */
  private applyPolicies(operation: IOpenApiOperation, docCache: ISwaggerCacheEntry, methodName: string): void {
    const controllerPolicies = docCache.controllerPolicies ?? [];
    const routePolicies = docCache.routePolicies?.[methodName] ?? [];
    const all = [...controllerPolicies, ...routePolicies];
    if (all.length === 0) return;

    operation['x-policies'] = all;

    const lines: string[] = [];
    for (const name of all) {
      const doc = docCache.policies?.[name];
      this.registerPolicyReference(name, doc);
      const anchor = this.policyAnchor(name);
      const scope = controllerPolicies.includes(name) && !routePolicies.includes(name) ? ' (controller)' : '';
      lines.push(`- [\`${name}\`](#${anchor})${scope}${doc?.description ? ` — ${this.firstSentence(doc.description)}` : ''}`);
    }

    const block = `**Policies applied:**\n${lines.join('\n')}`;
    operation.description = operation.description ? `${operation.description}\n\n${block}` : block;
  }

  /**
   * Lazily register a policy in the document-level "Policies" section.
   * OpenAPI 3.0 has no first-class "policies" components bucket, so we render
   * them into `info.description` as a markdown anchor that Swagger UI can
   * link to from operation descriptions.
   */
  private registerPolicyReference(name: string, doc?: { description?: string; file?: string }): void {
    if (this.registeredPolicies.has(name)) return;
    this.registeredPolicies.add(name);

    const anchor = this.policyAnchor(name);
    const description = doc?.description?.trim() || '_No description available — add JSDoc to the policy class._';
    this.policySectionEntries.push(`### <a id="${anchor}"></a>\`${name}\`\n\n${description}`);

    // Rebuild info.description so it always reflects the latest set
    const heading = '## Policies\n\nThe following policies are applied to one or more operations. ' +
      'Each policy runs before the route handler and may reject the request.\n\n';
    const base = this.infoDescriptionBase;
    this.document.info.description = `${base}${base ? '\n\n' : ''}${heading}${this.policySectionEntries.join('\n\n')}`;
  }

  private policyAnchor(name: string): string {
    return `policy-${name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`;
  }

  private firstSentence(text: string): string {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    const m = cleaned.match(/^[^.!?]+[.!?]/);
    return (m ? m[0] : cleaned).slice(0, 200);
  }

  /**
   * Read rbac-http's controller descriptor via the global metadata symbol.
   * Returns undefined when the controller isn't RBAC-decorated.
   */
  private readRbacDescriptor(
    instance: unknown,
  ): { resource: string; defaultPermission: string[]; routes: Map<string, string[]> } | undefined {
    if (!instance) return undefined;

    const ACL_SYMBOL = Symbol.for('ACL_CONTROLLER_DESCRIPTOR_SYMBOL');
    const meta = Reflect.getMetadata(ACL_SYMBOL, instance as object) as
      | {
          Resource?: string;
          Permission?: string[];
          Routes?: Map<string, { Permission?: string[] }>;
        }
      | undefined;

    if (!meta) return undefined;

    const routes = new Map<string, string[]>();
    if (meta.Routes && typeof meta.Routes.forEach === 'function') {
      meta.Routes.forEach((v, k) => {
        if (Array.isArray(v?.Permission)) routes.set(k, v.Permission);
      });
    }

    return {
      resource: meta.Resource ?? '',
      defaultPermission: Array.isArray(meta.Permission) ? meta.Permission : [],
      routes,
    };
  }

  /**
   * Attach RBAC info to an operation:
   *   - vendor extensions `x-rbac-resource` and `x-rbac-permissions` for
   *     tooling / code-gen consumers
   *   - a human-readable line appended to the description for Swagger UI
   */
  private applyRbac(
    operation: IOpenApiOperation,
    rbac: ReturnType<OpenApiBuilder['readRbacDescriptor']>,
    methodName: string,
  ): void {
    if (!rbac) return;

    const perRoute = rbac.routes.get(methodName);
    const permissions = perRoute && perRoute.length > 0 ? perRoute : rbac.defaultPermission;
    if (!rbac.resource && permissions.length === 0) return;

    if (rbac.resource) operation['x-rbac-resource'] = rbac.resource;
    if (permissions.length > 0) operation['x-rbac-permissions'] = permissions;

    const permList = permissions.length > 0 ? permissions.map((p) => `\`${p}\``).join(' or ') : '_any role with resource access_';
    const resourceText = rbac.resource ? `\`${rbac.resource}\`` : '_unspecified_';
    const line = `**RBAC:** requires ${permList} on resource ${resourceText}`;

    operation.description = operation.description ? `${operation.description}\n\n${line}` : line;
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
        path = `/${basePath}/`;
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
      // Per-operation security: undefined = inherit global, [] = public, [...] = explicit schemes
      security: methodDoc?.security,
    };

    const bodyParams: { param: IRouteParameter; doc?: { name: string; description?: string; type?: string } }[] = [];

    // Extract path param names from the Express route path as fallback when param.Name is not set
    const pathParamNames = (route.Path || '').match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)?.map((p) => p.slice(1)) ?? [];
    let pathParamIndex = 0;

    // Process route parameters
    for (const [, param] of route.Parameters) {
      if (INTERNAL_PARAMS.has(param.Type as string)) {
        continue;
      }

      // Resolve effective location. Most types come from PARAM_LOCATION_MAP,
      // but orm-http's @FromModel (Type='FromDbModel') is dynamic — it reads
      // the PK from req.params / query / body / header per Options.paramType,
      // defaulting to path. @Filter (Type='FilterModelRouteArg') always reads from query.
      let location: 'query' | 'path' | 'header' | 'cookie' | undefined = PARAM_LOCATION_MAP[param.Type as string];
      if (!location) {
        if (param.Type === 'FromDbModel') {
          location = this.fromDbModelLocation(param);
        } else if (param.Type === 'FilterModelRouteArg') {
          location = 'query';
        }
      }

      const isPathParam = location === 'path';
      const resolvedName = param.Name || (isPathParam ? pathParamNames[pathParamIndex++] : undefined);
      if (isPathParam && resolvedName && !param.Name) {
        param.Name = resolvedName;
      }

      const paramDoc = methodDoc?.params?.[resolvedName ?? param.Name];

      if (BODY_PARAMS.has(param.Type as string)) {
        bodyParams.push({ param, doc: paramDoc });
        continue;
      }

      if (location) {
        const apiParam = this.buildParameter(param, location, paramDoc, resolvedName);
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
   * Describe the JSON filter envelope used by orm-http's @Filter decorator.
   *
   * @Filter accepts either:
   *   - a Model constructor — @Filterable on its columns stores the filterable
   *     column map on the model descriptor (Reflect metadata under
   *     Symbol.for('MODEL_DESCRIPTOR')) at class-load time. We read it directly
   *     so the schema is available even before orm-http's runtime mixin attaches.
   *   - an IColumnFilter[] — we build the same envelope shape inline from the
   *     column descriptors.
   *
   * Both cases produce the same { op, filters: [...] } envelope as the runtime
   * builder in packages/orm-http/src/{model.ts,route-arg.ts}.
   */
  private buildFilterSchema(param: IRouteParameter): IOpenApiSchema {
    const options = param.Options as unknown;

    // Model-constructor case
    if (options && typeof options === 'function') {
      const columns = this.extractFilterableColumns(options as new (...args: unknown[]) => unknown);
      if (columns.length > 0) {
        return this.filterEnvelopeSchema(columns);
      }

      // Fall back to runtime mixin if metadata wasn't populated for some reason
      const ctor = options as { filterSchema?: () => unknown };
      if (typeof ctor.filterSchema === 'function') {
        try {
          const schema = ctor.filterSchema();
          if (schema && typeof schema === 'object') {
            return this.convertJsonSchema(schema);
          }
        } catch {
          // ignore
        }
      }
    }

    // Explicit IColumnFilter[] case
    if (Array.isArray(options)) {
      const columns = options
        .filter((x): x is { column: string; operators: string[] } => !!x && typeof x === 'object' && 'column' in x && 'operators' in x);
      if (columns.length > 0) {
        return this.filterEnvelopeSchema(columns);
      }
    }

    return {
      type: 'object',
      description: 'Filter envelope ({ op, filters: [...] })',
    };
  }

  /**
   * Read the FilterableColumns map from a model constructor via the orm model
   * descriptor metadata. Keeps http-swagger free of a hard @spinajs/orm dep —
   * the symbol is global (`Symbol.for('MODEL_DESCRIPTOR')`).
   *
   * The metadata IS the descriptor. orm keys it by class identity — one
   * descriptor owned by each constructor — so there is no name indexing to do
   * here. It used to be a container keyed by class name
   * (`{ [class.name]: descriptor }`), which collapsed two classes sharing a
   * name into one slot; reading that old shape now yields undefined and
   * silently drops every operator from the docs.
   */
  private extractFilterableColumns(modelCtor: new (...args: unknown[]) => unknown): { column: string; operators: string[] }[] {
    const MODEL_DESCRIPTOR_SYMBOL = Symbol.for('MODEL_DESCRIPTOR');
    const descriptor = Reflect.getMetadata(MODEL_DESCRIPTOR_SYMBOL, modelCtor) as
      | { FilterableColumns?: Map<string, { operators?: string[] }> }
      | undefined;
    if (!descriptor) return [];

    const map = descriptor.FilterableColumns;
    if (!map || typeof map.entries !== 'function') return [];

    const result: { column: string; operators: string[] }[] = [];
    for (const [column, val] of map.entries()) {
      result.push({ column, operators: val?.operators ?? [] });
    }
    return result;
  }

  /**
   * Build the { op, filters: [...] } envelope schema given a list of filterable columns.
   *
   * OAS 3.0.3 (the doc version we emit) does NOT support multi-type arrays for
   * `type` — that's an OAS 3.1 feature. Swagger UI renders such schemas as
   * "Unknown Type: ...". We emit `oneOf` for the Value union and single-typed
   * sub-schemas for everything else.
   */
  private filterEnvelopeSchema(columns: { column: string; operators: string[] }[]): IOpenApiSchema {
    const filterItems: IOpenApiSchema[] = columns.map((x) => ({
      type: 'object',
      required: ['Column', 'Value', 'Operator'],
      properties: {
        Column: { type: 'string', enum: [x.column], example: x.column },
        Value: {
          oneOf: [
            { type: 'string' },
            { type: 'integer' },
            { type: 'boolean' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'Scalar or array value matching the column type',
        },
        Operator: {
          type: 'string',
          enum: x.operators,
          example: x.operators[0],
        },
      },
    }));

    return {
      type: 'object',
      required: ['op', 'filters'],
      properties: {
        op: { type: 'string', enum: ['and', 'or'], example: 'and' },
        filters: {
          type: 'array',
          items: filterItems.length === 1
            ? filterItems[0]
            : ({ oneOf: filterItems } as IOpenApiSchema),
        },
      },
    };
  }

  /**
   * Resolve the effective OpenAPI location for orm-http's @FromModel param.
   * Mirrors FromDbModel.extract(): paramType decides where the PK is read from
   * (defaults to path/req.params).
   */
  private fromDbModelLocation(param: IRouteParameter): 'query' | 'path' | 'header' | 'cookie' {
    const paramType = (param.Options as { paramType?: string } | undefined)?.paramType;
    switch (paramType) {
      case ParameterType.FromQuery:
      case 'FromQuery':
        return 'query';
      case ParameterType.FromHeader:
      case 'FromHeader':
        return 'header';
      case ParameterType.FromBody:
      case 'FromBody':
        // FromBody body location is not a "parameter" in OpenAPI — fall back to path
        // (the common case) so the value still appears in the doc.
        return 'path';
      case ParameterType.FromParams:
      case 'FromParams':
      default:
        return 'path';
    }
  }

  /**
   * Build an OpenAPI parameter from route parameter info.
   */
  private buildParameter(
    param: IRouteParameter,
    location: 'query' | 'path' | 'header' | 'cookie',
    doc?: { name: string; description?: string; type?: string },
    resolvedName?: string,
  ): IOpenApiParameter {
    const schema = this.schemaFromParam(param, doc?.type);
    const isArray = schema?.type === 'array';
    const isObject = schema?.type === 'object';

    const base = {
      name: resolvedName || param.Name || `param_${param.Index}`,
      in: location,
      description: doc?.description,
      required: location === 'path',
    };

    if (isObject && location === 'query') {
      return { ...base, content: { 'application/json': { schema } } };
    }

    return {
      ...base,
      schema,
      ...(isArray && location === 'query' ? { style: 'form', explode: true } : {}),
    };
  }

  /**
   * Resolve the best schema for a route parameter.
   * Priority: JSDoc type → decorator schema (param.Schema) → auto-detected primitive (param.RouteParamSchema) → @Schema metadata on DTO class → runtime type inference
   */
  private schemaFromParam(param: IRouteParameter, docType?: string): IOpenApiSchema {
    if (docType) {
      return this.inferSchemaFromString(docType);
    }

    // orm-http @Filter — describe the JSON filter envelope so API consumers know what to send.
    if (param.Type === 'FilterModelRouteArg') {
      return this.buildFilterSchema(param);
    }

    if (param.Schema && typeof param.Schema === 'object') {
      return this.convertJsonSchema(param.Schema);
    }

    if (param.RouteParamSchema && typeof param.RouteParamSchema === 'object') {
      return this.convertJsonSchema(param.RouteParamSchema);
    }

    const runtimeType = param.RuntimeType;
    if (runtimeType) {
      if (runtimeType instanceof TypedArray) {
        const itemType = (runtimeType as TypedArray<any>).Type as any;
        const itemSchema = Reflect.getMetadata(SCHEMA_SYMBOL, itemType) ?? (itemType?.prototype ? Reflect.getMetadata(SCHEMA_SYMBOL, itemType.prototype) : undefined);
        if (itemSchema) {
          return { type: 'array', items: this.convertJsonSchema(itemSchema) };
        }
      } else {
        const rt = runtimeType as any;
        const classSchema = Reflect.getMetadata(SCHEMA_SYMBOL, rt) ?? (rt?.prototype ? Reflect.getMetadata(SCHEMA_SYMBOL, rt.prototype) : undefined);
        if (classSchema) {
          return this.convertJsonSchema(classSchema);
        }
      }
    }

    return this.inferSchema(runtimeType, undefined);
  }

  /**
   * Convert a JSON Schema object to an OpenAPI schema, mapping known keywords.
   */
  private convertJsonSchema(jsonSchema: any): IOpenApiSchema {
    if (!jsonSchema || typeof jsonSchema !== 'object') {
      return { type: 'string' };
    }

    const result: IOpenApiSchema = {};

    // OAS 3.0 forbids multi-type arrays (3.1 only). Translate to oneOf so Swagger UI
    // doesn't render "Unknown Type: ...".
    if (Array.isArray(jsonSchema.type)) {
      result.oneOf = (jsonSchema.type as string[]).map((t) =>
        t === 'array' ? { type: 'array', items: { type: 'string' } } : { type: t },
      );
    } else if (jsonSchema.type) {
      result.type = jsonSchema.type;
    }
    if (jsonSchema.format) result.format = jsonSchema.format;
    if (jsonSchema.description) result.description = jsonSchema.description;
    if (jsonSchema.enum) result.enum = jsonSchema.enum;
    if (jsonSchema.required) result.required = jsonSchema.required;
    if (jsonSchema.minimum !== undefined) result.minimum = jsonSchema.minimum;
    if (jsonSchema.maximum !== undefined) result.maximum = jsonSchema.maximum;
    if (jsonSchema.minLength !== undefined) result.minLength = jsonSchema.minLength;
    if (jsonSchema.maxLength !== undefined) result.maxLength = jsonSchema.maxLength;
    if (jsonSchema.pattern) result.pattern = jsonSchema.pattern;
    if (jsonSchema.nullable) result.nullable = jsonSchema.nullable;

    if (jsonSchema.items) {
      result.items = this.convertJsonSchema(jsonSchema.items);
    }

    if (jsonSchema.properties) {
      result.properties = {};
      for (const [k, v] of Object.entries(jsonSchema.properties)) {
        result.properties[k] = this.convertJsonSchema(v);
      }
    }

    if (Array.isArray(jsonSchema.oneOf)) {
      result.oneOf = jsonSchema.oneOf.map((s: any) => this.convertJsonSchema(s));
    }
    if (Array.isArray(jsonSchema.anyOf)) {
      result.anyOf = jsonSchema.anyOf.map((s: any) => this.convertJsonSchema(s));
    }
    if (Array.isArray(jsonSchema.allOf)) {
      result.allOf = jsonSchema.allOf.map((s: any) => this.convertJsonSchema(s));
    }
    if (jsonSchema.const !== undefined) {
      // OAS 3.0 has no `const` — emit single-value enum.
      result.enum = [jsonSchema.const];
      if (!result.type) result.type = typeof jsonSchema.const;
    }
    if (jsonSchema.example !== undefined) result.example = jsonSchema.example;

    // If only enum is present with no type, infer type from first enum value
    if (!result.type && result.enum && result.enum.length > 0) {
      result.type = typeof result.enum[0];
    }

    return result;
  }

  /**
   * Build an OpenAPI request body from body-type parameters.
   */
  private buildRequestBody(
    bodyParams: { param: IRouteParameter; doc?: { name: string; description?: string; type?: string } }[],
    _route: IRoute,
  ): IOpenApiRequestBody {
    // Any file/form-parsed param means the runtime expects multipart/form-data,
    // not JSON (covers FromFile, FromForm, FormField, FromCSV, FromJSONFile).
    const hasFile = bodyParams.some((bp) => MULTIPART_BODY_PARAMS.has(bp.param.Type as string));

    const contentType = hasFile ? 'multipart/form-data' : 'application/json';

    // If there's a single body param with a model type, use it directly
    if (bodyParams.length === 1 && !hasFile) {
      const bp = bodyParams[0];
      return {
        description: bp.doc?.description,
        required: true,
        content: {
          [contentType]: {
            schema: this.schemaFromParam(bp.param, bp.doc?.type),
          },
        },
      };
    }

    // Multiple body params → build an object schema
    const properties: Record<string, IOpenApiSchema> = {};
    for (const bp of bodyParams) {
      const name = bp.param.Name || `param_${bp.param.Index}`;
      properties[name] = {
        ...this.schemaFromParam(bp.param, bp.doc?.type),
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
   * Build response definitions from JSDoc @returns and @response tags.
   * Only responses explicitly documented in JSDoc are included.
   */
  private buildResponses(methodDoc: IMethodDocumentation | undefined): Record<string, IOpenApiResponse> {
    const responses: Record<string, IOpenApiResponse> = {};

    if (methodDoc?.returns) {
      const schema =
        methodDoc.returns.type
          ? this.inferSchemaFromString(methodDoc.returns.type)
          : (methodDoc.returns.schema ?? { type: 'object' });

      responses['200'] = {
        description: methodDoc.returns.description || 'Successful response',
        content: { 'application/json': { schema: this.expandNamedSchemas(schema) } },
      };
    } else {
      responses['200'] = { description: 'Successful response' };
    }

    if (methodDoc?.responses) {
      for (const [statusCode, resp] of Object.entries(methodDoc.responses)) {
        // If the JSDoc supplies an explicit schema type, render inline.
        // Otherwise, for known standard codes, $ref a reusable component so
        // Swagger UI shows a clickable link and the same error envelope schema
        // across the whole document.
        if (resp.type) {
          responses[statusCode] = {
            description: resp.description,
            content: { 'application/json': { schema: this.inferSchemaFromString(resp.type) } },
          };
          continue;
        }

        const refName = this.registerStandardResponse(statusCode, resp.description);
        if (refName) {
          responses[statusCode] = { $ref: `#/components/responses/${refName}` };
        } else {
          responses[statusCode] = { description: resp.description };
        }
      }
    }

    return responses;
  }

  /**
   * Lazily register a reusable response component for a standard HTTP status
   * code (e.g. 401 → `#/components/responses/Unauthorized`) and the shared
   * Error schema. Returns the component name to $ref, or undefined if the code
   * isn't in our standard set.
   *
   * JSDoc description overrides the default; first JSDoc description wins per
   * status code so the component stays stable across operations.
   */
  private registerStandardResponse(statusCode: string, description?: string): string | undefined {
    const name = STANDARD_RESPONSE_NAMES[statusCode];
    if (!name) return undefined;

    this.ensureErrorSchema();

    if (!this.registeredResponses.has(name)) {
      const components = (this.document.components ??= {});
      const responses = (components.responses ??= {});
      responses[name] = {
        description: description || STANDARD_RESPONSE_DESCRIPTIONS[statusCode] || name,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/Error' } },
        },
      };
      this.registeredResponses.add(name);
    }

    return name;
  }

  /**
   * Register the shared Error schema once. Matches the runtime error envelope
   * built in packages/http/src/error.ts (spread of the Error instance + message,
   * with optional stack in dev).
   */
  private ensureErrorSchema(): void {
    if (this.errorSchemaRegistered) return;

    const components = (this.document.components ??= {});
    const schemas = (components.schemas ??= {});
    if (!schemas.Error) {
      schemas.Error = {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string', description: 'Human-readable error message' },
          code: { type: 'integer', description: 'HTTP status code (when present)' },
          stack: { type: 'object', description: 'Stack trace — dev environments only', nullable: true },
        },
      };
    }
    this.errorSchemaRegistered = true;
  }

  /**
   * Swaps named-type nodes for a reusable component `$ref`, registering each component once.
   * Walks `items` and `properties` so nested types are expanded too.
   */
  private expandNamedSchemas(schema: IOpenApiSchema): IOpenApiSchema {
    // Case 1 — primitive / null: nothing to expand, return as-is.
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    // Case 2 — a named-model tag: replace the whole node with a $ref to its component.
    if (schema.description && !schema.$ref) {
      const ref = this.registerNamedComponent(schema.description);
      if (ref) {
        return { $ref: ref };
      }
    }

    // Case 3 — a container: keep the node, expand the two places a model can hide.
    if (schema.items) {
      schema.items = this.expandNamedSchemas(schema.items);
    }
    if (schema.properties) {
      for (const key of Object.keys(schema.properties)) {
        schema.properties[key] = this.expandNamedSchemas(schema.properties[key]);
      }
    }

    return schema;
  }

  /**
   * Registers `name` as a reusable component and returns its `$ref`.
   * Returns undefined when no provider recognises the name, so the caller leaves the node as-is.
   */
  private registerNamedComponent(name: string): string | undefined {
    const ref = `#/components/schemas/${name}`;
    // Already registered (or in progress) — just reference it.
    if (this.registeredComponents.has(name)) {
      return ref;
    }

    const resolved = this.SchemaProviders.map((p) => p.getSchema(name)).find((r) => !!r);
    if (!resolved) {
      return undefined;
    }

    this.registeredComponents.add(name);

    const components = (this.document.components ??= {});
    const schemas = (components.schemas ??= {});

    // Expand nested named tags into their own components.
    schemas[name] = this.expandNamedSchemas(this.convertJsonSchema(resolved));

    return ref;
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
    // parse when valid JSON, otherwise fall back to the raw string
    return safeParse(value, value);
  }
}
