import type { ControllerEntry, Manifest, ParamEntry, RouteEntry } from '@spinajs/manifest';
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
  schema: Schema;
}
interface RequestBody {
  required: boolean;
  content: Record<string, { schema: Schema }>;
}

const LOCATION: Record<string, Location> = {
  FromQuery: 'query',
  QueryField: 'query',
  FromParams: 'path',
  ParamField: 'path',
  FromHeader: 'header',
  HeadersField: 'header',
  FromCookie: 'cookie',
};
const BODY = new Set(['FromBody', 'BodyField', 'FromDbModel', 'AsDbModel', 'RawBody', 'FromXml', 'FromJSONFile', 'FromCSV']);
const FILE = new Set(['FromFile', 'FromFiles', 'CsvFile', 'JsonFile']);
const FORM = new Set([...FILE, 'FromForm', 'FormField']);

const BINARY: Schema = { type: 'string', format: 'binary' };

export function openApiPath(fullPath: string, basePath: string): string {
  const converted = fullPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
  const prefix = basePath.replace(/\/+$/, '');
  return `${prefix}${converted.startsWith('/') ? converted : `/${converted}`}`;
}

export function operationId(controller: ControllerEntry, route: RouteEntry): string {
  return `${controller.className.replace(/Controller$/, '')}_${route.handler}`;
}

function paramSchema(param: ParamEntry, registry: ComponentRegistry): Schema {
  const id = param.schema ?? param.runtimeType.schema;
  return id ? (registry.refOrInline(id) as Schema) : {};
}

/** A DTO used as a query parameter is flattened: one parameter per property, in declaration order. */
function explodeParam(param: ParamEntry, location: Location, manifest: Manifest, registry: ComponentRegistry): Parameter[] {
  const id = param.schema ?? param.runtimeType.schema;
  const body = id ? (manifest.schemas[id] as { properties?: Record<string, unknown>; required?: string[] } | undefined) : undefined;
  if (!body?.properties) return [{ name: param.name, in: location, required: param.required, schema: paramSchema(param, registry) }];
  const required = new Set(body.required ?? []);
  return Object.entries(body.properties).map(([name, schema]) => ({ name, in: location, required: required.has(name), schema: registry.rewrite(schema) as Schema }));
}

function formField(param: ParamEntry, registry: ComponentRegistry): Schema {
  if (param.kind === 'FromFiles') return { type: 'array', items: BINARY };
  return FILE.has(param.kind) ? BINARY : paramSchema(param, registry);
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

function buildRequest(controller: ControllerEntry, route: RouteEntry, path: string, manifest: Manifest, registry: ComponentRegistry) {
  const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  const parameters: Parameter[] = [];
  const formProps: Record<string, Schema> = {};
  const formRequired: string[] = [];
  let jsonBody: Schema | undefined;
  let multipart = false;

  for (const param of [...route.params].sort((a, b) => a.index - b.index)) {
    const location = LOCATION[param.kind];
    if (location === 'path') {
      if (!placeholders.includes(param.name)) throw new Error(`${operationId(controller, route)}: path parameter '${param.name}' has no '{${param.name}}' placeholder in '${path}'`);
      parameters.push({ name: param.name, in: 'path', required: true, schema: paramSchema(param, registry) });
    } else if (location) {
      parameters.push(...explodeParam(param, location, manifest, registry));
    } else if (BODY.has(param.kind)) {
      jsonBody = param.kind === 'RawBody' ? BINARY : paramSchema(param, registry);
    } else if (FORM.has(param.kind)) {
      multipart = true;
      formProps[param.name] = formField(param, registry);
      if (param.required) formRequired.push(param.name);
    }
  }
  for (const name of placeholders) {
    if (!parameters.some((p) => p.name === name && p.in === 'path')) parameters.push({ name, in: 'path', required: true, schema: { type: 'string' } });
  }

  let requestBody: RequestBody | undefined;
  if (multipart) {
    const schema: Schema = { type: 'object', properties: formProps, ...(formRequired.length ? { required: formRequired } : {}) };
    requestBody = { required: formRequired.length > 0, content: { 'multipart/form-data': { schema } } };
  } else if (jsonBody) {
    requestBody = { required: true, content: { 'application/json': { schema: jsonBody } } };
  }
  return { parameters, requestBody };
}

function buildOperation(manifest: Manifest, controller: ControllerEntry, route: RouteEntry, registry: ComponentRegistry, errorSchemaId: string, path: string): OpenAPIV3_1.OperationObject {
  const { parameters, requestBody } = buildRequest(controller, route, path, manifest, registry);
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

export function buildPaths(manifest: Manifest, registry: ComponentRegistry, options: { errorSchemaId: string; basePath: string }): OpenAPIV3_1.PathsObject {
  const paths: Record<string, Record<string, unknown>> = {};
  const entries = manifest.controllers.flatMap((controller) => controller.routes.map((route) => ({ controller, route })));
  entries.sort((a, b) => (a.route.fullPath < b.route.fullPath ? -1 : a.route.fullPath > b.route.fullPath ? 1 : a.route.method < b.route.method ? -1 : a.route.method > b.route.method ? 1 : 0));
  for (const { controller, route } of entries) {
    const path = openApiPath(route.fullPath, options.basePath);
    const method = route.method === 'file' ? 'get' : route.method;
    (paths[path] ??= {})[method] = buildOperation(manifest, controller, route, registry, options.errorSchemaId, path);
  }
  return paths;
}
