import { AuthzAdminFailure, GLOBAL } from '@spinajs/authz';
import type { AuthzAdminOptions, AuthzAdminQuery, PrincipalRef, ResourceRef } from '@spinajs/authz';

import type { AuthzAdminPageQuery, AuthzAssignmentsQuery, AuthzHoldersQuery, AuthzWriteOptionsQuery } from '../dto/queries.js';

type Page = { limit?: number; offset?: number; after?: string };

/** authz-rbac's AssignmentSubject; the list queries belong to models this package does not import. */
type AssignmentSubject = PrincipalRef | { readonly set: { readonly role: string; readonly scope: ResourceRef } };

function invalid(field: string, message: string): never {
  throw new AuthzAdminFailure('invalid_query', message, field);
}

/** `<type>` or `<type>:<id>`, split at the first `:` (ids may hold more); `$global` is GLOBAL. */
export function parseResourceRef(value: string, field: string): ResourceRef {
  if (value === GLOBAL.type) return GLOBAL;
  const at = value.indexOf(':');
  const type = at < 0 ? value : value.slice(0, at);
  if (type === '') invalid(field, `${field} must be <type> or <type>:<id>, got ${JSON.stringify(value)}`);
  if (at < 0) return { type };
  const id = value.slice(at + 1);
  if (id === '') invalid(field, `${field} must be <type> or <type>:<id>, got ${JSON.stringify(value)}`);
  return { type, id };
}

/** `<type>:<id>` (a principal) or `set:<role>@<type>:<id>` (a subject set). */
export function parseAssignmentSubject(value: string, field = 'subject'): AssignmentSubject {
  const bad = (): never => invalid(field, `${field} must be <type>:<id> or set:<role>@<type>:<id>, got ${JSON.stringify(value)}`);
  if (value.startsWith('set:')) {
    const rest = value.slice('set:'.length);
    const at = rest.indexOf('@');
    if (at <= 0) return bad();
    const scope = rest.slice(at + 1);
    if (scope === '' || scope.endsWith(':')) return bad();
    return { set: { role: rest.slice(0, at), scope: parseResourceRef(scope, field) } };
  }
  const at = value.indexOf(':');
  if (at <= 0 || at === value.length - 1) return bad();
  return { type: value.slice(0, at), id: value.slice(at + 1) };
}

/** `limit`, `offset` and `after` as AuthzAdmin's page, only the ones given; AuthzAdmin defaults the rest. `after` replaces `offset`. */
function page(q: AuthzAdminPageQuery): { page?: Page } {
  const { limit, offset, after } = q;
  if (after !== undefined && offset !== undefined) invalid('after', 'after replaces offset: give one of them');
  if (limit === undefined && offset === undefined && after === undefined) return {};
  return { page: { ...(limit === undefined ? {} : { limit }), ...(offset === undefined ? {} : { offset }), ...(after === undefined ? {} : { after }) } };
}

function scope(q: AuthzAdminPageQuery): { scope?: ResourceRef } {
  return q.scope === undefined ? {} : { scope: parseResourceRef(q.scope, 'scope') };
}

/** GET /authz/assignments: `scope`, `subject`, `role`, `includeExpired`, `limit`, `offset` or `after`. */
export function readAssignmentsQuery(q: AuthzAssignmentsQuery): AuthzAdminQuery {
  return {
    kind: 'assignments',
    ...scope(q),
    ...(q.subject === undefined ? {} : { subject: parseAssignmentSubject(q.subject) }),
    ...(q.role === undefined ? {} : { role: q.role }),
    ...(q.includeExpired === undefined ? {} : { includeExpired: q.includeExpired }),
    ...page(q),
  } as unknown as AuthzAdminQuery;
}

/** GET /authz/holders: `scope` and `permission` (both required), `expandSets`, `limit`, `offset` or `after`. */
export function readHoldersQuery(q: AuthzHoldersQuery): AuthzAdminQuery {
  if (q.scope === undefined) invalid('scope', 'scope is required');
  return {
    kind: 'holders',
    scope: parseResourceRef(q.scope, 'scope'),
    permission: q.permission,
    ...(q.expandSets === undefined ? {} : { expandSets: q.expandSets }),
    ...page(q),
  } as unknown as AuthzAdminQuery;
}

/** GET /authz/links, /authz/rules and /authz/policies: `scope`, `limit`, `offset` or `after` (policies have no `after`, which their query DTO refuses). */
export function readPageQuery(kind: 'links' | 'rules' | 'policies', q: AuthzAdminPageQuery): AuthzAdminQuery {
  return { kind, ...scope(q), ...page(q) } as unknown as AuthzAdminQuery;
}

/** The AuthzAdminOptions of a single-command route: `reason`, `idempotencyKey`, `dryRun`. */
export function readWriteOptions(q: AuthzWriteOptionsQuery): AuthzAdminOptions {
  return {
    ...(q.reason === undefined ? {} : { reason: q.reason }),
    ...(q.idempotencyKey === undefined ? {} : { idempotencyKey: q.idempotencyKey }),
    ...(q.dryRun === undefined ? {} : { dryRun: q.dryRun }),
  };
}
