import { Autoinject, ClassInfo, TypedArray } from '@spinajs/di';
import { BaseController, IRoute, IRouteParameter, ParameterType, RouteType } from '@spinajs/http';
import { SCHEMA_SYMBOL, SchemaProvider } from '@spinajs/validation';
import { InvalidArgument } from '@spinajs/exceptions';
import { safeParse } from '@spinajs/util';
import {
  IOpenApiDocument,
  IOpenApiExample,
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
 * Body params whose WIRE representation is an uploaded file, whatever the action ends up
 * receiving. @CsvFile() and @JsonFile() belong here as much as @File() does: the argument is
 * handed the PARSED content, but the request still carries one file, and the request body is
 * what this document describes.
 *
 * @Form() and @FormField() are deliberately absent - those are ordinary form fields.
 */
const FILE_BODY_PARAMS = new Set<string>([
  ParameterType.FromFile, 'FromFile',
  ParameterType.FromCSV, 'FromCSV',
  ParameterType.FromJSONFile, 'FromJSONFile',
]);

/**
 * Of the file params, only @File() / @Files() can carry more than one file under one field.
 * The CSV and JSON extractors take `files[0]` and reject an empty field ( see FromCSV /
 * FromJSONFile in @spinajs/http's route-args/FromForm.ts ), so an array-typed argument there
 * describes the PARSED rows, never the upload.
 */
const MULTI_FILE_PARAMS = new Set<string>([ParameterType.FromFile, 'FromFile']);

/**
 * Media type per framework response class that streams a file instead of serialising JSON.
 * Keyed by class NAME because that is all the documentation layer ever sees - the return type
 * arrives as a string, out of the JSDoc tag or the declaration file.
 *
 * `FileResponse` gets the generic binary type: its real one is a constructor option
 * (`IFileResponseOptions.mimeType`) and is often left unset so `res.sendFile` can derive it
 * from the file, so there is nothing to read here. `ZipResponse` pins application/zip the
 * same way its constructor does, and `JsonFileResponse` always writes JSON - as an
 * attachment, which is why it is still a binary body and not a JSON one.
 */
const FILE_RESPONSE_MEDIA_TYPES: Record<string, string> = {
  FileResponse: 'application/octet-stream',
  ZipResponse: 'application/zip',
  JsonFileResponse: 'application/json',
};

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

/**
 * Which side of the wire a schema describes. A model's `@Schema` is the WRITE contract
 * (what a client may send); its columns are the READ contract (what the API hands back).
 * They are not the same object and must not be documented as one.
 */
type SchemaKind = 'request' | 'response';

/**
 * Every `{placeholder}` an OpenAPI path template carries, in template order.
 *
 * The template is the single source of truth for path parameters. It is read from the
 * FULL path the document emits (controller `@BasePath` + route path + configured
 * `basePath` prefix), not from `route.Path` — a placeholder declared in `@BasePath` is
 * invisible to `route.Path` and rejecting an argument that names it would be a false
 * alarm.
 *
 * Deduplicated: `name` + `in` is a parameter's identity in OpenAPI, so a template that
 * repeats a placeholder still yields one parameter.
 */
function pathTemplatePlaceholders(template: string): string[] {
  const names = (template.match(/{([a-zA-Z_][a-zA-Z0-9_]*)}/g) ?? []).map((p) => p.slice(1, -1));
  return [...new Set(names)];
}

export class OpenApiBuilder {
  private config: ISwaggerConfig;
  private document: IOpenApiDocument;
  private tags: Map<string, IOpenApiTag> = new Map();
  private registeredResponses: Set<string> = new Set();
  private registeredComponents: Set<string> = new Set();
  /** Per type name: whether its two flavours differ and therefore need two components. */
  private componentClaims: Map<string, { split: boolean }> = new Map();
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
        fullPath,
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
   *
   * `fullPath` is the OpenAPI path template this operation is filed under. It — not the
   * argument list — decides which path parameters the operation has; see
   * resolvePathPlaceholder() for the contract a declared argument must satisfy.
   */
  private buildOperation(
    controllerName: string,
    methodName: string,
    route: IRoute,
    methodDoc: IMethodDocumentation | undefined,
    tagName: string,
    fullPath: string,
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

    // The URL template owns the path parameters. Arguments only enrich them.
    const placeholders = pathTemplatePlaceholders(fullPath);

    // Placeholder -> the argument that declares it. At most one argument per placeholder;
    // a second one is a defect in the controller, not something to reconcile here.
    const declaredPlaceholders = new Map<string, { param: IRouteParameter; doc?: { name: string; description?: string; type?: string } }>();

    // Parameters other than path ones, kept in argument order.
    const otherParams: IOpenApiParameter[] = [];

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

          // fromDbModelLocation() answers 'path' for paramType=FromBody too, only so the
          // value stays visible somewhere in the document. A body key has no URL
          // placeholder to match and readsPathParam() is the authority on that, so it is
          // not a path parameter and must not be pushed through the strict resolver.
          // It carries no OpenAPI location at all — a body is described by requestBody.
          if (location === 'path' && !this.readsPathParam(param)) {
            location = undefined;
          }
        } else if (param.Type === 'FilterModelRouteArg') {
          location = 'query';
        }
      }

      // JSDoc is written against the argument name.
      const paramDoc = methodDoc?.params?.[param.Name];

      if (BODY_PARAMS.has(param.Type as string)) {
        bodyParams.push({ param, doc: paramDoc });
        continue;
      }

      if (location === 'path') {
        const placeholder = this.resolvePathPlaceholder(controllerName, methodName, param, placeholders, fullPath);
        const previous = declaredPlaceholders.get(placeholder);

        if (previous) {
          throw new InvalidArgument(
            `${controllerName}.${methodName}: path placeholder \`${placeholder}\` is declared twice, ` +
              `by \`${previous.param.Name}\` and by \`${param.Name}\`, in route \`${fullPath}\`. ` +
              `Each placeholder must be declared by at most one argument — drop one of them, ` +
              `or point its paramField at a different placeholder.`,
          );
        }

        declaredPlaceholders.set(placeholder, { param, doc: paramDoc ?? methodDoc?.params?.[placeholder] });
        continue;
      }

      if (location) {
        otherParams.push(this.buildParameter(param, location, paramDoc, this.emittedParamName(param)));
      }
    }

    // Emit one required parameter per placeholder, in template order. A placeholder nobody
    // declares is still a parameter the caller has to fill in: the backend compiles with
    // `noUnusedParameters`, so a handler that never reads `:campaign` CANNOT declare an
    // argument for it, and the URL template is then the only place that knows about it.
    for (const name of placeholders) {
      const declared = declaredPlaceholders.get(name);
      operation.parameters!.push(
        declared
          ? this.buildParameter(declared.param, 'path', declared.doc, name)
          : { name, in: 'path', required: true, schema: { type: 'string' } },
      );
    }

    operation.parameters!.push(...otherParams);

    // Build request body from body params
    if (bodyParams.length > 0) {
      operation.requestBody = this.buildRequestBody(bodyParams, route);
    }

    // Attach @example tags: to the request body when the route has one,
    // otherwise (e.g. GET routes) to the 200 response — a bodyless route's
    // examples can only describe what it returns.
    if (methodDoc?.examples) {
      let content: { examples?: Record<string, IOpenApiExample> } | undefined;
      if (operation.requestBody) {
        content = operation.requestBody.content['application/json'];
      } else {
        const ok = operation.responses['200'];
        if (ok && !ok.$ref) {
          ok.content ??= { 'application/json': {} };
          content = ok.content['application/json'] ??= {};
        }
      }
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
   * The name a non-path parameter is emitted under.
   *
   * orm-http's FromDbModel._extractValue reads `req.query[paramField ?? Name]` (same for
   * headers), so an explicit `paramField` IS the wire name and the TypeScript argument name
   * is not what the runtime looks for. Path parameters do not go through here — their name
   * is the placeholder, see resolvePathPlaceholder().
   */
  private emittedParamName(param: IRouteParameter): string | undefined {
    const paramField = (param.Options as { paramField?: string } | undefined)?.paramField;
    return paramField || param.Name || undefined;
  }

  /**
   * The URL placeholder a path-bound argument declares — or a throw.
   *
   * Path parameters are emitted from the URL template (see buildOperation); a declared
   * argument only enriches the one it names, with its schema and its JSDoc description.
   * There are exactly two ways to name one:
   *
   *   1. `Options.paramField` — that IS the placeholder, and it must exist in the template.
   *      It is also the field orm-http's FromDbModel.extract() reads from `req.params`, so
   *      the document and the runtime agree by construction.
   *   2. the argument's own name, when it equals a placeholder.
   *
   * Anything else throws. No positional assignment, no "first free placeholder", no
   * underscore aliasing: a controller the documentation layer cannot read unambiguously is
   * a controller to fix, not to guess at. An underscore-prefixed argument (`_campaign`,
   * written only to satisfy `noUnusedParameters`) matches no placeholder and therefore
   * throws — the fix is to DELETE the argument, because the placeholder is emitted from the
   * template whether anything declares it or not.
   *
   * The message has to be enough to fix the route without opening this file: it names the
   * controller, the method, the argument, the template, every placeholder that template
   * carries and the two ways out.
   */
  private resolvePathPlaceholder(
    controllerName: string,
    methodName: string,
    param: IRouteParameter,
    placeholders: string[],
    fullPath: string,
  ): string {
    const paramField = (param.Options as { paramField?: string } | undefined)?.paramField;
    const argument = param.Name || `argument #${param.Index}`;

    const available =
      placeholders.length > 0
        ? `Available placeholders: ${placeholders.join(', ')}.`
        : 'The route declares no path placeholders at all.';
    const suggestion = placeholders.length > 0 ? placeholders[0] : 'name';
    const fix =
      `Either rename the argument to a placeholder the route really has, or name one explicitly ` +
      `with the decorator's paramField option, e.g. @FromModel({ paramField: '${suggestion}' }). ` +
      `If the handler never reads the value, delete the argument instead: every placeholder is ` +
      `documented from the URL template whether an argument declares it or not. Path parameters ` +
      `are resolved strictly — the documentation layer does not guess.`;

    if (paramField) {
      if (placeholders.includes(paramField)) {
        return paramField;
      }

      throw new InvalidArgument(
        `${controllerName}.${methodName}: path argument \`${argument}\` declares paramField ` +
          `\`${paramField}\`, which matches no placeholder in route \`${fullPath}\`. ${available} ${fix}`,
      );
    }

    if (param.Name && placeholders.includes(param.Name)) {
      return param.Name;
    }

    throw new InvalidArgument(
      `${controllerName}.${methodName}: path argument \`${argument}\` matches no placeholder ` +
        `in route \`${fullPath}\`. ${available} ${fix}`,
    );
  }

  /**
   * Whether an @FromModel parameter reads its key from the URL path.
   *
   * Mirrors orm-http's FromDbModel._extractValue: only an absent `paramType` ( the default )
   * or an explicit FromParams reaches `req.params`. Query / body / header keys live somewhere
   * else entirely and have no business claiming a URL placeholder.
   */
  private readsPathParam(param: IRouteParameter): boolean {
    const paramType = (param.Options as { paramType?: string } | undefined)?.paramType;
    return paramType === undefined || paramType === null || paramType === ParameterType.FromParams || (paramType as string) === 'FromParams';
  }

  /**
   * Schema for the value an @FromModel parameter actually carries: the key the model
   * is looked up by, never the model itself. The runtime picks that column the same
   * way (FromDbModel.fromDbModelDefaultQueryFunction): `Options.queryField` if given,
   * otherwise the model's primary key.
   *
   * The descriptor is read through the global `Symbol.for('MODEL_DESCRIPTOR')` so this
   * package keeps no @spinajs/orm dependency (same trick as extractFilterableColumns).
   * `PrimaryKey` is filled only by the @Primary decorator, so legacy models without it
   * fall back to the column the driver introspected as primary.
   */
  private fromDbModelKeySchema(param: IRouteParameter): IOpenApiSchema {
    const modelCtor = param.RuntimeType;
    const descriptor =
      typeof modelCtor === 'function'
        ? (Reflect.getMetadata(Symbol.for('MODEL_DESCRIPTOR'), modelCtor) as
            | { Name?: string; PrimaryKey?: string[] | string; Columns?: { Name: string; Type?: string; PrimaryKey?: boolean }[] }
            | undefined)
        : undefined;

    const columns = Array.isArray(descriptor?.Columns) ? descriptor!.Columns! : [];
    const primaryKey = descriptor?.PrimaryKey;
    const declaredKey = Array.isArray(primaryKey) ? primaryKey[0] : primaryKey || undefined;
    const keyName = (param.Options as { queryField?: string } | undefined)?.queryField ?? declaredKey ?? columns.find((c) => c.PrimaryKey)?.Name;

    const modelName = descriptor?.Name || (typeof modelCtor === 'function' ? (modelCtor as { name?: string }).name : undefined);
    const column = keyName ? columns.find((c) => c.Name === keyName) : undefined;

    // No descriptor at all (model metadata not loaded) still beats `type: object` —
    // whatever the key is, it travels as a single scalar in the URL or query string.
    const schema = this.schemaFromDbColumnType(column?.Type);

    return {
      ...schema,
      description: modelName && keyName ? `${modelName}.${keyName}` : modelName ? `${modelName} key` : undefined,
    };
  }

  /**
   * Map a database column type (driver's DATA_TYPE) to an OpenAPI primitive.
   * Unknown types fall back to string — the value travels as a URL segment anyway.
   */
  private schemaFromDbColumnType(type: string | undefined): IOpenApiSchema {
    const normalized = (type ?? '')
      .toLowerCase()
      .replace(/\(.*$/, '')
      .replace(/\s+unsigned$/, '')
      .trim();

    switch (normalized) {
      case 'tinyint':
      case 'smallint':
      case 'mediumint':
      case 'int':
      case 'integer':
      case 'year':
        return { type: 'integer' };
      case 'bigint':
        return { type: 'integer', format: 'int64' };
      case 'float':
      case 'double':
      case 'real':
        return { type: 'number' };
      case 'bool':
      case 'boolean':
      case 'bit':
        return { type: 'boolean' };
      // DECIMAL/NUMERIC come back from the driver as strings (precision is not
      // survivable as a JS number), so the doc must say string as well.
      case 'decimal':
      case 'numeric':
        return { type: 'string' };
      case 'date':
        return { type: 'string', format: 'date' };
      case 'datetime':
      case 'timestamp':
        return { type: 'string', format: 'date-time' };
      default:
        return { type: 'string' };
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
    // An upload, before anything else gets a say. A file's schema is a fact of the DECORATOR,
    // not of the argument's TypeScript type ( `IUploadedFile` is an interface, so it erases to
    // `Object` and lands as a bare `{ type: 'object' }` ) and not of a JSDoc tag either: on a
    // @CsvFile() the author documents the parsed ROWS, which is exactly the case that produced
    // a spec demanding a JSON object where the client has to send a File.
    if (FILE_BODY_PARAMS.has(param.Type as string)) {
      return this.fileSchema(param);
    }

    if (docType) {
      return this.inferSchemaFromString(docType);
    }

    // orm-http @Filter — describe the JSON filter envelope so API consumers know what to send.
    if (param.Type === 'FilterModelRouteArg') {
      return this.buildFilterSchema(param);
    }

    // orm-http @FromModel — the request carries the key the model is loaded by, not the
    // model. The model's own schema describes a write body and would document this
    // parameter as an object, which no URL segment can be.
    if (param.Type === 'FromDbModel') {
      return this.fromDbModelKeySchema(param);
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
          const converted = this.convertJsonSchema(classSchema);
          this.applyRelationMetadata(converted, rt);
          return converted;
        }
      }
    }

    return this.inferSchema(runtimeType, undefined);
  }

  /**
   * The schema of an uploaded file: `type: string, format: binary`, which is how OAS 3.0
   * spells a binary payload inside multipart/form-data. Generators read `format` and nothing
   * else - it is what makes a client type the field `Blob` / `File` and Swagger UI render a
   * file picker instead of a text box.
   *
   * Arity follows the RUNTIME's own rule, character for character ( `FromForm.extract`:
   * `RuntimeType.name === 'Array' || Options.asArray === true` ) so the document and the
   * extractor cannot disagree about whether a field takes one file or several. `@Files()` is
   * `@File({ asArray: true })`, which is why the option has to be consulted and not just the
   * declared type.
   *
   * A fresh object every call: `expandNamedSchemas` mutates the nodes it walks, so a shared
   * constant would be rewritten under every route that used it.
   *
   * @param param - the route parameter to describe
   */
  private fileSchema(param: IRouteParameter): IOpenApiSchema {
    const file: IOpenApiSchema = { type: 'string', format: 'binary' };

    if (!MULTI_FILE_PARAMS.has(param.Type as string)) {
      return file;
    }

    const asArray = (param.Options as { asArray?: boolean } | undefined)?.asArray === true;
    const isArrayType = (param.RuntimeType as { name?: string } | undefined)?.name === 'Array';

    return asArray || isArrayType ? { type: 'array', items: file } : file;
  }

  /**
   * The response content for a route that streams a file, or undefined for anything else - in
   * which case the caller documents a JSON body exactly as it always did.
   *
   * A framework file response is not describable as a schema: `FileResponse`, `ZipResponse`
   * and `JsonFileResponse` all write bytes plus a `Content-Disposition: attachment` header,
   * never a serialised instance of themselves. Documented as `{ type: 'object' }` under
   * application/json - the fallback for any class name no schema provider recognises - a
   * generated client parses the download as JSON and rejects every successful response.
   *
   * Both halves of `returns` have to be consulted. `@returns {FileResponse}` puts the name in
   * `type`, but a route that merely DECLARES the return type ( the common case, and what the
   * declaration file carries ) gets no `type` at all: @spinajs/http's parser resolves a named
   * class to `{ type: 'object', description: name }` in `schema`, and the name lives in the
   * description. Only a bare tag counts there - an object with a shape of its own describes
   * itself, and its description is prose.
   *
   * @param returns - the documented return, from a JSDoc tag or the declaration file
   */
  private fileResponseContent(returns: { type?: string; schema?: IOpenApiSchema }): Record<string, { schema: IOpenApiSchema }> | undefined {
    const schema = returns.schema;
    const tagged = schema && schema.type === 'object' && !schema.properties && !schema.items ? schema.description : undefined;
    const name = (returns.type ?? tagged)?.replace(/[{}]/g, '').trim();

    const mediaType = name ? FILE_RESPONSE_MEDIA_TYPES[name] : undefined;

    return mediaType ? { [mediaType]: { schema: { type: 'string', format: 'binary' } } } : undefined;
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

    // A map keyed by data — RBAC grants are resource → action → descriptor, so
    // the names cannot be enumerated and `properties` cannot describe them.
    // Dropping this collapsed such a schema to a bare `object`. `false` is kept
    // as-is: it says "no unknown keys", which is a real constraint, not a value
    // schema.
    if (typeof jsonSchema.additionalProperties === 'boolean') {
      result.additionalProperties = jsonSchema.additionalProperties;
    } else if (jsonSchema.additionalProperties) {
      result.additionalProperties = this.convertJsonSchema(jsonSchema.additionalProperties);
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
   * Enriches a DTO schema with orm-http @Relation annotations. The relation
   * descriptors are read via the global symbol `Symbol.for('orm-http:relations')`
   * so this package needs no dependency on orm-http.
   */
  private applyRelationMetadata(schema: IOpenApiSchema, runtimeType: any): void {
    const RELATION_SYMBOL = Symbol.for('orm-http:relations');
    const rel = (Reflect.getMetadata(RELATION_SYMBOL, runtimeType) ?? (runtimeType?.prototype ? Reflect.getMetadata(RELATION_SYMBOL, runtimeType.prototype) : undefined)) as
      | { Relations: Map<string, { field: string; target: () => any; by?: string }> }
      | undefined;

    if (!rel || !schema.properties) {
      return;
    }

    for (const [field, desc] of rel.Relations) {
      const prop = schema.properties[field];
      if (!prop) continue;

      const modelName = desc.target()?.name ?? 'model';
      const byLabel = desc.by ?? 'primary key';
      const note = `Reference to ${modelName} by ${byLabel}. Must match an existing record (404 if not found).`;
      prop.description = prop.description ? `${prop.description} ${note}` : note;
      (prop as any)['x-relation'] = { model: modelName, by: desc.by };
    }
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
            schema: this.expandNamedSchemas(this.schemaFromParam(bp.param, bp.doc?.type)),
          },
        },
      };
    }

    // Multiple body params → build an object schema
    const properties: Record<string, IOpenApiSchema> = {};
    for (const bp of bodyParams) {
      const name = bp.param.Name || `param_${bp.param.Index}`;
      const expanded = this.expandNamedSchemas(this.schemaFromParam(bp.param, bp.doc?.type));
      properties[name] = expanded.$ref
        ? expanded
        : { ...expanded, description: bp.doc?.description };
    }

    // `@File({ required: true })` is enforced by the uploader at runtime, so the document has
    // to say so too - `requestBody.required` only states that a body is expected at all, and a
    // multipart body missing its file field satisfies that while still being rejected with a
    // 400. Only file params are consulted: the other body params have no comparable option and
    // their `required` lists come from their own schemas.
    const required = bodyParams
      .filter((bp) => FILE_BODY_PARAMS.has(bp.param.Type as string) && (bp.param.Options as { required?: boolean } | undefined)?.required === true)
      .map((bp) => bp.param.Name || `param_${bp.param.Index}`);

    return {
      required: true,
      content: {
        [contentType]: {
          schema: {
            type: 'object',
            properties,
            ...(required.length > 0 ? { required } : {}),
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

    // When the JSDoc explicitly documents a non-200 success (e.g. `@response 202`)
    // and there is no explicit `@returns` tag (returns carries only the
    // TS-inferred schema), the operation's success status IS that 2xx — don't
    // fabricate a 200 alongside it.
    const hasExplicit2xx = !!methodDoc?.responses && Object.keys(methodDoc.responses).some((c) => c.startsWith('2'));
    const returnsIsInferredOnly = !!methodDoc?.returns && !methodDoc.returns.type && !methodDoc.returns.description;

    if (methodDoc?.returns && !(hasExplicit2xx && returnsIsInferredOnly)) {
      const download = this.fileResponseContent(methodDoc.returns);

      const schema =
        methodDoc.returns.type
          ? this.inferSchemaFromString(methodDoc.returns.type)
          : (methodDoc.returns.schema ?? { type: 'object' });

      responses['200'] = {
        description: methodDoc.returns.description || 'Successful response',
        content: download ?? { 'application/json': { schema: this.expandNamedSchemas(schema, 'response') } },
      };
    } else if (!hasExplicit2xx) {
      responses['200'] = { description: 'Successful response' };
    }

    if (methodDoc?.responses) {
      for (const [statusCode, resp] of Object.entries(methodDoc.responses)) {
        // If the JSDoc supplies an explicit schema type, render inline.
        // Otherwise, for known standard codes, $ref a reusable component so
        // Swagger UI shows a clickable link and the same error envelope schema
        // across the whole document.
        if (resp.type) {
          const download = this.fileResponseContent({ type: resp.type });

          responses[statusCode] = {
            description: resp.description,
            content: download ?? { 'application/json': { schema: this.expandNamedSchemas(this.inferSchemaFromString(resp.type), 'response') } },
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
   *
   * `kind` says which side of the wire this subtree describes and is carried down the whole
   * walk — a relation nested in a response is still a response. It defaults to 'request'
   * so every caller that never had an opinion keeps the schema it always got.
   */
  private expandNamedSchemas(schema: IOpenApiSchema, kind: SchemaKind = 'request'): IOpenApiSchema {
    // Case 1 — primitive / null: nothing to expand, return as-is.
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    // Case 2 — a named-model tag: replace the whole node with a $ref to its component.
    if (this.isNamedTypeTag(schema)) {
      const ref = this.registerNamedComponent(schema.description as string, kind);
      if (ref) {
        return { $ref: ref };
      }
    }

    // Case 3 — a container: keep the node, expand the two places a model can hide.
    if (schema.items) {
      schema.items = this.expandNamedSchemas(schema.items, kind);
    }
    if (schema.properties) {
      for (const key of Object.keys(schema.properties)) {
        schema.properties[key] = this.expandNamedSchemas(schema.properties[key], kind);
      }
    }

    return schema;
  }

  /**
   * Is this node a bare "here is a type NAME" placeholder, the shape `inferSchema`,
   * `inferSchemaFromString` and the ORM's relation properties all produce -
   * `{ type: 'object', description: 'TestUser' }` and nothing else?
   *
   * `description` alone is not enough to say so, because it is also where genuine prose ends
   * up: a column's DB `Comment` ( @spinajs/orm's `columnToSchema` ), orm-http's relation note,
   * a `@Schema()` author's own text. A comment that happens to read like a model name -
   * "File", "User" - then replaced the whole property with a `$ref` to that model, turning a
   * scalar into an object and DISCARDING everything the node said about itself. A
   * `format: date-time` timestamp lost the one keyword every generated client needs to read it
   * as a date, silently and only on the columns that carry a comment.
   *
   * So a node that describes itself is left alone. Only an untyped node, or one typed `object`
   * with no shape of its own, can still be a type tag.
   *
   * @param schema - node under consideration
   */
  private isNamedTypeTag(schema: IOpenApiSchema): boolean {
    if (!schema.description || schema.$ref) {
      return false;
    }

    if (schema.type !== undefined && schema.type !== 'object') {
      return false;
    }

    return !schema.format && !schema.properties && !schema.items && !schema.enum && !schema.oneOf && !schema.anyOf && !schema.allOf;
  }

  /**
   * Registers `name` as a reusable component and returns its `$ref`.
   * Returns undefined when no provider recognises the name, so the caller leaves the node as-is.
   */
  private registerNamedComponent(name: string, kind: SchemaKind = 'request'): string | undefined {
    const resolved = this.resolveNamedSchema(name, kind);
    if (!resolved) {
      return undefined;
    }

    const componentName = this.componentNameFor(name, kind, resolved);
    const ref = `#/components/schemas/${componentName}`;

    // Already registered (or in progress) — just reference it. Registering BEFORE the
    // expansion below is what stops a cyclic relation from recursing forever.
    if (this.registeredComponents.has(componentName)) {
      return ref;
    }
    this.registeredComponents.add(componentName);

    const components = (this.document.components ??= {});
    const schemas = (components.schemas ??= {});

    // Expand nested named tags into their own components.
    schemas[componentName] = this.expandNamedSchemas(this.convertJsonSchema(resolved), kind);

    return ref;
  }

  /**
   * Pick the schema a component should be built from.
   *
   * An ORM model carries two different contracts under one name: `@Schema` says what a
   * client may SEND, the model's own columns say what the API RETURNS. Serving the write
   * schema as the response contract is how a response ends up missing every column the
   * database generates (`id`, `created_at`), missing `nullable` on columns that are null in
   * practice, carrying `maxLength` copied from the column width, and demanding fields a
   * response legitimately omits — enough for a generated client validator to reject
   * ordinary rows.
   *
   * So a response asks the providers for their response flavour first. Providers that have
   * none (a `@Schema` DTO is the same object both ways) return undefined and we fall back
   * to `getSchema` — which is also the only thing a request ever consults.
   */
  private resolveNamedSchema(name: string, kind: SchemaKind): Record<string, unknown> | undefined {
    if (kind === 'response') {
      // optional call — a provider compiled against an older @spinajs/validation has no such method
      const response = this.SchemaProviders.map((p) => p.getResponseSchema?.(name)).find((r) => !!r);
      if (response) {
        return response;
      }
    }

    return this.SchemaProviders.map((p) => p.getSchema(name)).find((r) => !!r);
  }

  /**
   * Component name for `name` in the given flavour.
   *
   * A type whose two flavours agree is ONE component called `<Name>`. When they differ the
   * response keeps `<Name>` and the request becomes `<Name>Request` — always, whichever
   * flavour the traversal happens to reach first. Letting the first arrival keep the base
   * name made the suffix a function of controller-discovery ( filesystem ) order: adding or
   * renaming an unrelated controller could flip `User` to `UserRequest` in every generated
   * client, with nothing in the diff to explain it.
   *
   * The response is the half that keeps the plain name because it is the half most of a
   * client's surface is built from — a list screen references the row type far more often
   * than the write form does.
   *
   * Both flavours are resolved here, at the first encounter, precisely so the answer does not
   * depend on which one asked. Providers are pure lookups, so asking twice costs nothing.
   *
   * @param name - type name to place in components
   * @param kind - flavour being registered right now
   * @param resolved - the schema already resolved for `kind`, reused instead of re-asking
   */

  private componentNameFor(name: string, kind: SchemaKind, resolved: Record<string, unknown>): string {
    let claim = this.componentClaims.get(name);

    if (!claim) {
      const request = kind === 'request' ? resolved : this.resolveNamedSchema(name, 'request');
      const response = kind === 'response' ? resolved : this.resolveNamedSchema(name, 'response');
      const requestKey = request && this.schemaKey(request);
      const responseKey = response && this.schemaKey(response);

      // An unserializable schema counts as "differs": that costs one extra component but
      // never merges two contracts into one.
      claim = { split: !requestKey || !responseKey || requestKey !== responseKey };
      this.componentClaims.set(name, claim);
    }

    return claim.split && kind === 'request' ? `${name}Request` : name;
  }

  /**
   * Identity of a resolved schema, used only to tell "both flavours, same contract" from
   * "both flavours, different contract". Undefined when the schema can't be serialized —
   * then the two flavours are assumed to differ, which costs a component but never merges
   * two contracts into one.
   */
  private schemaKey(schema: Record<string, unknown>): string | undefined {
    try {
      return JSON.stringify(schema);
    } catch {
      return undefined;
    }
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
   * Infer schema from a JSDoc type string like {string}, {number}, {MyDto}, {MyDto[]}
   */
  private inferSchemaFromString(typeStr: string): IOpenApiSchema {
    const cleaned = typeStr.replace(/[{}]/g, '').trim();

    // `X[]` / `Array<X>` - a documented LIST. Without this branch the brackets stay part of
    // the name, so the tag falls through to the default below and lands in `description` as
    // `User[]`: a name no schema provider resolves, leaving the response described as a bare
    // `{ type: 'object' }`. A generated client then validates an array against an object
    // schema and rejects every successful response ( `@returns {IUserData[]}` on rbac's user
    // list was the live case ). Recursive, so `X[][]` nests.
    const element = cleaned.endsWith('[]') ? cleaned.slice(0, -2).trim() : /^Array<(.+)>$/.exec(cleaned)?.[1]?.trim();

    if (element) {
      return { type: 'array', items: this.inferSchemaFromString(element) };
    }

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
