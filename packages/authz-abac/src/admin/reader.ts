import { AuthzAdminFailure, AuthzAdminReader } from '@spinajs/authz';
import type { AdminContext, AuthzAdminQuery, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { isPlainObject, quote, sameScope, writableStore } from './common.js';

// AuthzAdmin passes a checked page; a direct caller gets the admin's default.
function pageOf(q: AuthzAdminQuery): { limit: number; offset: number } {
  const p = (q as { page?: unknown }).page;
  if (p === undefined) return { limit: 50, offset: 0 };
  if (!isPlainObject(p) || !Number.isInteger(p.limit) || !Number.isInteger(p.offset) || (p.limit as number) < 0 || (p.offset as number) < 0) throw new AuthzAdminFailure('invalid_query', 'page must be { limit, offset } with non-negative integers', 'page');
  return { limit: p.limit as number, offset: p.offset as number };
}

function scopeOf(q: AuthzAdminQuery): ResourceRef | undefined {
  const s: unknown = (q as { scope?: unknown }).scope;
  if (s === undefined) return undefined;
  if (!isPlainObject(s) || typeof s.type !== 'string' || s.type === '' || (s.id != null && (typeof s.id !== 'string' || s.id === ''))) throw new AuthzAdminFailure('invalid_query', 'scope must be a resource ref { type, id? }', 'scope');
  return s as unknown as ResourceRef;
}

/** list() of the policies in the domain's writable PolicyStore, by id; a scope lists those whose scope is exactly it (GLOBAL: the unscoped ones). */
@Singleton()
@Injectable(AuthzAdminReader)
export class AbacPolicyReader extends AuthzAdminReader {
  readonly kinds = ['policies'] as const;

  async list(q: AuthzAdminQuery, ctx: AdminContext): Promise<{ items: readonly unknown[]; total: number }> {
    if (q.kind !== 'policies') throw new AuthzAdminFailure('not_found', `AbacPolicyReader does not answer ${quote(q.kind)}`, 'kind');
    const page = pageOf(q);
    const scope = scopeOf(q);
    const all = await (await writableStore(ctx)).load();
    const items = all.filter((p) => scope === undefined || sameScope(p, { scope })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { items: items.slice(page.offset, page.offset + page.limit), total: items.length };
  }
}
