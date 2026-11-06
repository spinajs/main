import type { ControllerEntry, RouteEntry } from '@spinajs/manifest';
import type { OpenAPIV3_1 } from 'openapi-types';
import type { ComponentRegistry } from './components.js';
import { isAnonymous, permissionsOf } from './security.js';

const STANDARD: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  413: 'Payload too large',
  422: 'Validation error',
  500: 'Internal server error',
};

function problem(status: number, description: string | undefined, registry: ComponentRegistry, errorSchemaId: string): OpenAPIV3_1.ResponseObject {
  return { description: description ?? STANDARD[status] ?? String(status), content: { 'application/problem+json': { schema: { $ref: registry.ref(errorSchemaId) } } } };
}

type Schema = Record<string, unknown>;

const isSchema = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The response schema of a field-filtered route (`@Access(…, { fields })`): every property optional and marked with
 * the permission whose field set decides it. A component is copied inline, so routes without filtering keep it as is.
 */
export function redactable(schema: unknown, permission: string, registry: ComponentRegistry, depth = 0): unknown {
  if (!isSchema(schema) || depth > 8) return schema;
  if (typeof schema.$ref === 'string') {
    const component = registry.schemas()[schema.$ref.replace('#/components/schemas/', '')];
    return isSchema(component) ? redactable(component, permission, registry, depth + 1) : schema;
  }
  const { required: _required, ...rest } = schema;
  const out: Schema = { ...rest };
  if (isSchema(schema.items)) out.items = redactable(schema.items, permission, registry, depth + 1);
  if (isSchema(schema.properties)) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, p]) => [name, isSchema(p) ? { ...p, 'x-spina-fields': permission } : p]));
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) if (Array.isArray(schema[key])) out[key] = (schema[key] as unknown[]).map((m) => redactable(m, permission, registry, depth + 1));
  return out;
}

/** The permission whose field set redacts the route's response, when the route filters fields. */
function fieldsPermission(route: RouteEntry, controller: ControllerEntry): string | undefined {
  const filtered = [...route.middlewares, ...controller.middlewares].some((m) => m.type === 'AuthzFieldsMiddleware');
  return filtered ? permissionsOf(route, controller)[0] : undefined;
}

function success(route: RouteEntry, controller: ControllerEntry, registry: ComponentRegistry): OpenAPIV3_1.ResponseObject {
  if (route.method === 'file') return { description: 'Successful response', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
  const id = route.returnType.schema;
  if (!id) return { description: 'Successful response' };
  const permission = fieldsPermission(route, controller);
  const schema = permission === undefined ? registry.refOrInline(id) : redactable(registry.refOrInline(id), permission, registry);
  return { description: 'Successful response', content: { 'application/json': { schema: schema as OpenAPIV3_1.SchemaObject } } };
}

function documented(route: RouteEntry, registry: ComponentRegistry, errorSchemaId: string, responses: OpenAPIV3_1.ResponsesObject): void {
  for (const doc of route.doc?.responses ?? []) {
    responses[String(doc.status)] = doc.type?.schema
      ? { description: doc.description ?? STANDARD[doc.status] ?? String(doc.status), content: { 'application/json': { schema: registry.refOrInline(doc.type.schema) as OpenAPIV3_1.SchemaObject } } }
      : problem(doc.status, doc.description, registry, errorSchemaId);
  }
}

function implied(route: RouteEntry, controller: ControllerEntry, errorMap: Record<string, number>): number[] {
  const statuses = new Set(Object.values(errorMap));
  if (permissionsOf(route, controller).length > 0 && !isAnonymous(route, controller)) {
    statuses.add(401);
    statuses.add(403);
  }
  if (route.params.some((p) => p.wire && p.wire.in !== 'none')) statuses.add(400);
  return [...statuses];
}

export function buildResponses(route: RouteEntry, controller: ControllerEntry, errorMap: Record<string, number>, registry: ComponentRegistry, errorSchemaId: string): OpenAPIV3_1.ResponsesObject {
  const responses: OpenAPIV3_1.ResponsesObject = {};
  const text = route.returnType.text;
  if (text === 'void' || text === 'undefined') responses['204'] = { description: 'No content' };
  else responses['200'] = success(route, controller, registry);

  documented(route, registry, errorSchemaId, responses);
  for (const status of implied(route, controller, errorMap)) {
    if (!responses[String(status)]) responses[String(status)] = problem(status, undefined, registry, errorSchemaId);
  }

  return Object.fromEntries(Object.entries(responses).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
