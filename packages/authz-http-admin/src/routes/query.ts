import { AuthzAdminFailure, GLOBAL } from '@spinajs/authz';
import type { AssignmentSubject, AuthzAdminOptions, AuthzAdminQuery, ResourceRef } from '@spinajs/authz';

/** A parsed query string (express: string, string[] or a nested object per key). */
export type QueryInput = Readonly<Record<string, unknown>>;

type Page = { limit?: number; offset?: number };

function invalid(field: string, message: string): never {
  throw new AuthzAdminFailure('invalid_query', message, field);
}

function text(q: QueryInput, field: string): string | undefined {
  const v = q[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') invalid(field, `${field} must be given once, as text`);
  return v;
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

function flag(q: QueryInput, field: string): boolean | undefined {
  const v = text(q, field);
  if (v === undefined) return undefined;
  if (v !== 'true' && v !== 'false') invalid(field, `${field} must be true or false`);
  return v === 'true';
}

function count(q: QueryInput, field: string): number | undefined {
  const v = text(q, field);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) invalid(field, `${field} must be a non-negative integer`);
  return Number(v);
}

/** `limit` and `offset` as AuthzAdmin's page, only the ones given; AuthzAdmin defaults the rest. */
function page(q: QueryInput): { page?: Page } {
  const limit = count(q, 'limit');
  const offset = count(q, 'offset');
  if (limit === undefined && offset === undefined) return {};
  return { page: { ...(limit === undefined ? {} : { limit }), ...(offset === undefined ? {} : { offset }) } };
}

function scope(q: QueryInput): { scope?: ResourceRef } {
  const v = text(q, 'scope');
  return v === undefined ? {} : { scope: parseResourceRef(v, 'scope') };
}

/** GET /authz/assignments: `scope`, `subject`, `role`, `includeExpired`, `limit`, `offset`. */
export function readAssignmentsQuery(q: QueryInput): AuthzAdminQuery {
  const subject = text(q, 'subject');
  const role = text(q, 'role');
  const includeExpired = flag(q, 'includeExpired');
  return {
    kind: 'assignments',
    ...scope(q),
    ...(subject === undefined ? {} : { subject: parseAssignmentSubject(subject) }),
    ...(role === undefined ? {} : { role }),
    ...(includeExpired === undefined ? {} : { includeExpired }),
    ...page(q),
  } as AuthzAdminQuery;
}

/** GET /authz/rules and /authz/policies: `scope`, `limit`, `offset`. */
export function readPageQuery(kind: 'rules' | 'policies', q: QueryInput): AuthzAdminQuery {
  return { kind, ...scope(q), ...page(q) } as AuthzAdminQuery;
}

/** The AuthzAdminOptions of a single-command route: `reason`, `idempotencyKey`, `dryRun`. */
export function readWriteOptions(q: QueryInput): AuthzAdminOptions {
  const reason = text(q, 'reason');
  const idempotencyKey = text(q, 'idempotencyKey');
  const dryRun = flag(q, 'dryRun');
  return {
    ...(reason === undefined ? {} : { reason }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(dryRun === undefined ? {} : { dryRun }),
  };
}
