import { AUTHZ_ADMIN_SCHEMAS } from './provider.js';

type Json = Record<string, any>;

interface RouteDoc {
  readonly method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  readonly path: string;
  readonly body?: string;
  readonly query?: readonly string[];
}

const WRITE_OPTIONS = ['reason', 'idempotencyKey', 'dryRun'] as const;

const QUERY: Readonly<Record<string, Json>> = {
  scope: { schema: { type: 'string' }, description: '`<type>` or `<type>:<id>`, split at the first `:`; `$global` is the global scope' },
  subject: { schema: { type: 'string' }, description: '`<type>:<id>` (a principal) or `set:<role>@<type>:<id>` (a subject set)' },
  role: { schema: { type: 'string' }, description: 'only assignments of this role' },
  includeExpired: { schema: { type: 'boolean' }, description: '`true` or `false`' },
  limit: { schema: { type: 'integer', minimum: 0 }, description: 'page size; the server sets the default' },
  offset: { schema: { type: 'integer', minimum: 0 }, description: 'rows to skip' },
  reason: { schema: { type: 'string' }, description: 'goes to the audit trail' },
  idempotencyKey: { schema: { type: 'string' }, description: 'a retried request with the same key returns the first result' },
  dryRun: { schema: { type: 'boolean' }, description: '`true` validates and guards, then rolls back' },
};

const PATH_PARAMS: Readonly<Record<string, string>> = {
  id: 'the id of the row (assignment, link, rule, policy) or of the scope node',
  type: 'the resource type of the scope node',
};

/** What each route takes that the controller's signature cannot say: its body and its query string. */
export const AUTHZ_ADMIN_ROUTES: readonly RouteDoc[] = [
  { method: 'post', path: '/authz/commands', body: 'AuthzAdminBatch' },
  { method: 'get', path: '/authz/assignments', query: ['scope', 'subject', 'role', 'includeExpired', 'limit', 'offset'] },
  { method: 'post', path: '/authz/assignments', body: 'AuthzAssignmentGrant', query: WRITE_OPTIONS },
  { method: 'patch', path: '/authz/assignments/{id}', body: 'AuthzAssignmentPatch', query: WRITE_OPTIONS },
  { method: 'delete', path: '/authz/assignments/{id}', query: WRITE_OPTIONS },
  { method: 'get', path: '/authz/links', query: ['scope', 'limit', 'offset'] },
  { method: 'post', path: '/authz/links', body: 'AuthzLinkCreate', query: WRITE_OPTIONS },
  { method: 'patch', path: '/authz/links/{id}', body: 'AuthzLinkPatch', query: WRITE_OPTIONS },
  { method: 'delete', path: '/authz/links/{id}', query: WRITE_OPTIONS },
  { method: 'get', path: '/authz/rules', query: ['scope', 'limit', 'offset'] },
  { method: 'put', path: '/authz/rules/{id}', body: 'AuthzRuleBody', query: WRITE_OPTIONS },
  { method: 'delete', path: '/authz/rules/{id}', query: WRITE_OPTIONS },
  { method: 'get', path: '/authz/policies', query: ['scope', 'limit', 'offset'] },
  { method: 'put', path: '/authz/policies/{id}', body: 'AuthzPolicyBody', query: WRITE_OPTIONS },
  { method: 'delete', path: '/authz/policies/{id}', query: WRITE_OPTIONS },
  { method: 'get', path: '/authz/scopes/{type}/{id}/attributes' },
  { method: 'patch', path: '/authz/scopes/{type}/{id}/attributes', body: 'AuthzAttributesPatch', query: WRITE_OPTIONS },
  { method: 'put', path: '/authz/scopes/{type}/{id}/attributes', body: 'AuthzAttributesBody', query: WRITE_OPTIONS },
];

/**
 * http-swagger describes a route's body and query string from decorated arguments, and the admin
 * routes read both from `@Req()` so that no http-layer step can refuse what AuthzAdmin would answer.
 * This adds what the builder cannot see to an OpenAPI document it built: the request bodies, the
 * query parameters, the path parameter text and the body schemas as components. Operations are
 * matched by method and path suffix, so a route prefix does not matter. Changes the document in place.
 */
export function describeAuthzAdminDocument<T extends object>(doc: T): T {
  const document = doc as Json;
  const components = ((document.components ??= {}).schemas ??= {}) as Json;
  for (const [name, schema] of Object.entries(AUTHZ_ADMIN_SCHEMAS)) components[name] ??= schema;

  for (const route of AUTHZ_ADMIN_ROUTES) {
    const path = Object.keys(document.paths ?? {}).find((p) => p === route.path || p.endsWith(route.path));
    const operation = path ? document.paths[path][route.method] : undefined;
    if (!operation) continue;

    if (route.body) operation.requestBody = { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${route.body}` } } } };

    const parameters: Json[] = (operation.parameters ??= []);
    for (const p of parameters) if (p.in === 'path' && !p.description) p.description = PATH_PARAMS[p.name];
    for (const name of route.query ?? []) {
      if (!parameters.some((p) => p.in === 'query' && p.name === name)) parameters.push({ name, in: 'query', required: false, ...QUERY[name] });
    }
  }
  return doc;
}
