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

const INPUT_KINDS = new Set(['FromBody', 'FromForm', 'FromQuery', 'FromParams', 'FromFile']);

function problem(status: number, description: string | undefined, registry: ComponentRegistry, errorSchemaId: string): OpenAPIV3_1.ResponseObject {
  return { description: description ?? STANDARD[status] ?? String(status), content: { 'application/problem+json': { schema: { $ref: registry.ref(errorSchemaId) } } } };
}

function success(route: RouteEntry, registry: ComponentRegistry): OpenAPIV3_1.ResponseObject {
  if (route.method === 'file') return { description: 'Successful response', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
  const id = route.returnType.schema;
  if (!id) return { description: 'Successful response' };
  return { description: 'Successful response', content: { 'application/json': { schema: registry.refOrInline(id) as OpenAPIV3_1.SchemaObject } } };
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
  if (route.params.some((p) => INPUT_KINDS.has(p.kind))) statuses.add(400);
  return [...statuses];
}

export function buildResponses(route: RouteEntry, controller: ControllerEntry, errorMap: Record<string, number>, registry: ComponentRegistry, errorSchemaId: string): OpenAPIV3_1.ResponsesObject {
  const responses: OpenAPIV3_1.ResponsesObject = {};
  const text = route.returnType.text;
  if (text === 'void' || text === 'undefined') responses['204'] = { description: 'No content' };
  else responses['200'] = success(route, registry);

  documented(route, registry, errorSchemaId, responses);
  for (const status of implied(route, controller, errorMap)) {
    if (!responses[String(status)]) responses[String(status)] = problem(status, undefined, registry, errorSchemaId);
  }

  return Object.fromEntries(Object.entries(responses).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
