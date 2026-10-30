import { servedPath, withRoutePrefix } from '@spinajs/manifest';
import type { ControllerEntry, Manifest, ParamEntry, ParamWire, RouteEntry } from '@spinajs/manifest';
import type { OpenAPIV3_1 } from 'openapi-types';
import type { ComponentRegistry } from './components.js';
import { buildResponses } from './responses.js';
import { applyAccess } from './security.js';

type Location = 'query' | 'path' | 'header' | 'cookie';
type Schema = Record<string, unknown>;

// openapi-types' V3_1 object types do not compose with each other (a V3_1 schema is rejected as a V3_1 parameter schema), so the pieces are typed locally.
interface Parameter {
  name: string;
  in: Location;
  required: boolean;
  schema?: Schema;
  content?: Record<string, { schema: Schema }>;
  style?: 'form';
  explode?: boolean;
}
interface MediaType {
  schema: Schema;
  encoding?: Record<string, { contentType: string }>;
}
interface RequestBody {
  required: boolean;
  content: Record<string, MediaType>;
}

/** Everything sent in one request body: whole-body arguments and named fields (`body[name]`, form parts). */
interface BodyParts {
  media?: string;
  wholes: { schema: Schema; required: boolean }[];
  fields: Record<string, Schema>;
  requiredFields: string[];
  encoding: Record<string, { contentType: string }>;
}

interface RequestScope {
  controller: ControllerEntry;
  route: RouteEntry;
  path: string;
  manifest: Manifest;
  registry: ComponentRegistry;
}

const PARAM_LOCATIONS = new Set<string>(['query', 'path', 'header', 'cookie']);
const WHOLE_BODY_MEDIA: Record<string, string> = { RawBodyRouteArgs: 'application/octet-stream', FromXmlRouteArgs: 'application/xml' };
const FILE_KINDS = new Set(['FromFile', 'FromCSV', 'FromJSONFile']);
const BINARY: Schema = { type: 'string', format: 'binary' };
const JSON_MEDIA = 'application/json';

/** `fullPath` is the path the route answers at; `routePrefix` is `http.controllers.route.prefix`, applied as the router applies it. */
export function openApiPath(fullPath: string, basePath = '', routePrefix?: string): string {
  const converted = servedPath(withRoutePrefix(routePrefix, fullPath)).replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
  return `${basePath.replace(/\/+$/, '')}${converted}`;
}

export function operationId(controller: ControllerEntry, route: RouteEntry): string {
  return `${controller.className.replace(/Controller$/, '')}_${route.handler}`;
}

function wireOf(param: ParamEntry, scope: RequestScope): ParamWire {
  if (param.wire) return param.wire;
  throw new Error(`${operationId(scope.controller, scope.route)}: parameter '${param.name}' (kind '${param.kind}') has no wire binding; rebuild the manifest with a compiler that records ParamEntry.wire`);
}

function paramSchema(param: ParamEntry, registry: ComponentRegistry): Schema {
  const id = param.schema ?? param.runtimeType.schema;
  return id ? (registry.refOrInline(id) as Schema) : {};
}

function objectBody(param: ParamEntry, manifest: Manifest): { id: string; properties: Record<string, unknown>; required: string[] } | undefined {
  const id = param.schema ?? param.runtimeType.schema;
  if (!id || !Object.hasOwn(manifest.schemas, id)) return undefined;
  const body = manifest.schemas[id] as { properties?: Record<string, unknown>; required?: string[] };
  return body.properties ? { id, properties: body.properties, required: body.required ?? [] } : undefined;
}

function namedParam(param: ParamEntry, wire: ParamWire, location: Location, scope: RequestScope): Parameter {
  const name = wire.name ?? param.name;
  if (location === 'path' && !scope.path.includes(`{${name}}`)) {
    throw new Error(`${operationId(scope.controller, scope.route)}: path parameter '${name}' has no '{${name}}' placeholder in '${scope.path}'`);
  }
  const required = location === 'path' || param.required;
  const schema = paramSchema(param, scope.registry);
  // OpenAPI 3.1 describes a JSON-encoded parameter with `content`, not `schema`.
  return wire.shape === 'json' ? { name, in: location, required, content: { [JSON_MEDIA]: { schema } } } : { name, in: location, required, schema };
}

/** The argument is the whole query / params / headers / cookies: each DTO property is one key on the wire. */
function wholeParams(param: ParamEntry, location: Location, scope: RequestScope): Parameter[] {
  const body = objectBody(param, scope.manifest);
  if (!body) {
    // Without declared properties a whole query is still documented as free-form keys; headers and params have nothing to name.
    return location === 'query' ? [{ name: param.name, in: 'query', required: false, schema: paramSchema(param, scope.registry), style: 'form', explode: true }] : [];
  }
  const required = new Set(body.required);
  return Object.entries(body.properties)
    .filter(([name]) => location !== 'path' || scope.path.includes(`{${name}}`))
    .map(([name, schema]) => ({
      name,
      in: location,
      required: location === 'path' || required.has(name),
      schema: scope.registry.rewrite(schema, body.id) as Schema,
      ...(location === 'query' ? { style: 'form' as const, explode: true } : {}),
    }));
}

function emptyParts(): BodyParts {
  return { wholes: [], fields: {}, requiredFields: [], encoding: {} };
}

function addField(parts: BodyParts, name: string, schema: Schema, required: boolean): void {
  parts.fields[name] = schema;
  if (required && !parts.requiredFields.includes(name)) parts.requiredFields.push(name);
}

function addBodyParam(parts: BodyParts, param: ParamEntry, wire: ParamWire, registry: ComponentRegistry): void {
  if (wire.shape !== 'whole') {
    addField(parts, wire.name ?? param.name, paramSchema(param, registry), param.required);
    return;
  }
  const media = WHOLE_BODY_MEDIA[param.kind];
  if (media) parts.media = media;
  parts.wholes.push({ schema: param.kind === 'RawBodyRouteArgs' ? BINARY : paramSchema(param, registry), required: param.required });
}

function addMultipartParam(parts: BodyParts, param: ParamEntry, wire: ParamWire, registry: ComponentRegistry): void {
  if (wire.shape === 'whole') {
    parts.wholes.push({ schema: paramSchema(param, registry), required: param.required });
    return;
  }
  const name = wire.name ?? param.name;
  const part = FILE_KINDS.has(param.kind) ? BINARY : paramSchema(param, registry);
  addField(parts, name, FILE_KINDS.has(param.kind) && wire.multiple ? { type: 'array', items: part } : part, param.required);
  if (wire.shape === 'json') parts.encoding[name] = { contentType: JSON_MEDIA };
}

function composeSchema(parts: BodyParts): Schema {
  const names = Object.keys(parts.fields);
  const object: Schema | undefined = names.length ? { type: 'object', properties: parts.fields, ...(parts.requiredFields.length ? { required: parts.requiredFields } : {}) } : undefined;
  const schemas = [...parts.wholes.map((w) => w.schema), ...(object ? [object] : [])];
  return schemas.length === 1 ? schemas[0] : { allOf: schemas };
}

function isEmpty(parts: BodyParts): boolean {
  return parts.wholes.length === 0 && Object.keys(parts.fields).length === 0;
}

/** A multipart route reads its body fields from the same form, so they join the form parts. */
function requestBodyOf(body: BodyParts, multipart: BodyParts): RequestBody | undefined {
  const parts = isEmpty(multipart) ? body : { ...multipart, wholes: [...multipart.wholes, ...body.wholes], fields: { ...body.fields, ...multipart.fields }, requiredFields: [...body.requiredFields, ...multipart.requiredFields] };
  if (isEmpty(parts)) return undefined;
  const media = isEmpty(multipart) ? (body.media ?? JSON_MEDIA) : 'multipart/form-data';
  const required = parts.wholes.some((w) => w.required) || parts.requiredFields.length > 0;
  const encoding = Object.keys(parts.encoding).length ? { encoding: parts.encoding } : {};
  return { required, content: { [media]: { schema: composeSchema(parts), ...encoding } } };
}

function addParameters(parameters: Parameter[], added: Parameter[]): void {
  for (const p of added) {
    if (!parameters.some((q) => q.name === p.name && q.in === p.in)) parameters.push(p);
  }
}

function buildRequest(scope: RequestScope): { parameters: Parameter[]; requestBody?: RequestBody } {
  const parameters: Parameter[] = [];
  const body = emptyParts();
  const multipart = emptyParts();

  for (const param of [...scope.route.params].sort((a, b) => a.index - b.index)) {
    const wire = wireOf(param, scope);
    if (PARAM_LOCATIONS.has(wire.in)) {
      const location = wire.in as Location;
      addParameters(parameters, wire.shape === 'whole' ? wholeParams(param, location, scope) : [namedParam(param, wire, location, scope)]);
    } else if (wire.in === 'body') {
      addBodyParam(body, param, wire, scope.registry);
    } else if (wire.in === 'multipart') {
      addMultipartParam(multipart, param, wire, scope.registry);
    }
  }
  for (const [, name] of scope.path.matchAll(/\{([^}]+)\}/g)) {
    addParameters(parameters, [{ name, in: 'path', required: true, schema: { type: 'string' } }]);
  }
  const requestBody = requestBodyOf(body, multipart);
  return requestBody ? { parameters, requestBody } : { parameters };
}

function errorMapOf(manifest: Manifest, controller: ControllerEntry): Record<string, number> {
  const map: Record<string, number> = {};
  for (const value of manifest.values) {
    if (value.token !== '__http_error_map__' || value.kind !== 'map' || !value.mapKey || value.source.file !== controller.source.file) continue;
    const status = (value.value as { status?: unknown } | undefined)?.status;
    if (typeof status === 'number') map[value.mapKey] = status;
  }
  return map;
}

function buildOperation(scope: RequestScope, errorSchemaId: string): OpenAPIV3_1.OperationObject {
  const { controller, route, manifest, registry } = scope;
  const { parameters, requestBody } = buildRequest(scope);
  const operation = {
    operationId: operationId(controller, route),
    tags: route.doc?.tags ?? [controller.className.replace(/Controller$/, '')],
    ...(route.doc?.summary ? { summary: route.doc.summary } : {}),
    ...(route.doc?.description ? { description: route.doc.description } : {}),
    ...(route.doc?.deprecated ? { deprecated: true } : {}),
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses: buildResponses(route, controller, errorMapOf(manifest, controller), registry, errorSchemaId),
  } as unknown as OpenAPIV3_1.OperationObject;
  applyAccess(operation, route, controller);
  return operation;
}

export function buildPaths(manifest: Manifest, registry: ComponentRegistry, options: { errorSchemaId: string; basePath: string; routePrefix?: string }): OpenAPIV3_1.PathsObject {
  const paths: Record<string, Record<string, unknown>> = {};
  const entries = manifest.controllers.flatMap((controller) => controller.routes.map((route) => ({ controller, route })));
  entries.sort((a, b) => (a.route.fullPath < b.route.fullPath ? -1 : a.route.fullPath > b.route.fullPath ? 1 : a.route.method < b.route.method ? -1 : a.route.method > b.route.method ? 1 : 0));
  for (const { controller, route } of entries) {
    const path = openApiPath(route.fullPath, options.basePath, options.routePrefix);
    // A 'file' route is a plain GET that is known to return a binary body.
    const method = route.method === 'file' ? 'get' : route.method;
    const operation = (paths[path] ??= {});
    if (operation[method]) throw new Error(`duplicate operation ${method.toUpperCase()} ${path}: ${(operation[method] as { operationId: string }).operationId} and ${operationId(controller, route)}`);
    operation[method] = buildOperation({ controller, route, path, manifest, registry }, options.errorSchemaId);
  }
  return paths;
}
