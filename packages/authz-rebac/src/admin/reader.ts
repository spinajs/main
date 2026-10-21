import { AuthzAdminFailure, AuthzAdminReader } from '@spinajs/authz';
import type { AdminContext, AuthzAdminQuery, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import type { TupleQuery } from '../contracts.js';
import { NAME_PATTERN } from '../keys.js';
import { querySubject, writableStore } from './common.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// AuthzAdmin passes a checked page; a direct caller gets the admin's default.
function pageOf(p: unknown): { limit: number; offset: number } {
  if (p === undefined) return { limit: 50, offset: 0 };
  if (!isRecord(p) || !Number.isInteger(p.limit) || !Number.isInteger(p.offset) || (p.limit as number) < 0 || (p.offset as number) < 0) throw new AuthzAdminFailure('invalid_query', 'page must be { limit, offset } with non-negative integers', 'page');
  if (p.after !== undefined) throw new AuthzAdminFailure('invalid_query', 'tuples pages by offset; page.after is not supported', 'page.after');
  return { limit: p.limit as number, offset: p.offset as number };
}

function readQuery(q: Record<string, unknown>): TupleQuery {
  const scope = q.scope;
  if (scope !== undefined && (!isRecord(scope) || typeof scope.type !== 'string' || scope.type === '' || (scope.id != null && (typeof scope.id !== 'string' || scope.id === '')))) throw new AuthzAdminFailure('invalid_query', 'scope must be a resource ref { type, id? }', 'scope');
  if (q.relation !== undefined && (typeof q.relation !== 'string' || !NAME_PATTERN.test(q.relation))) throw new AuthzAdminFailure('invalid_query', 'relation must be a relation name', 'relation');
  return {
    ...(scope !== undefined ? { object: (scope.id == null ? { type: scope.type } : { type: scope.type, id: scope.id }) as ResourceRef } : {}),
    ...(q.relation !== undefined ? { relation: q.relation } : {}),
    ...(q.subject !== undefined ? { subject: querySubject(q.subject) } : {}),
  };
}

/** list() of the tuples in the domain's writable TupleStore, narrowed by scope (object or namespace), relation and subject. */
@Singleton()
@Injectable(AuthzAdminReader)
export class RebacTupleReader extends AuthzAdminReader {
  readonly kinds = ['tuples'] as const;

  async list(q: AuthzAdminQuery, ctx: AdminContext): Promise<{ items: readonly unknown[]; total: number }> {
    if (q.kind !== 'tuples') throw new AuthzAdminFailure('not_found', `RebacTupleReader does not answer ${JSON.stringify(q.kind)}`, 'kind');
    const raw = q as unknown as Record<string, unknown>;
    const query = readQuery(raw);
    const page = pageOf(raw.page);
    const out = await (await writableStore(ctx)).find(query, page);
    return { items: out.items.map((t) => structuredClone(t)), total: out.total };
  }
}
