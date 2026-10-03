import { AuthzAdminFailure, AuthzAdminReader } from '@spinajs/authz';
import type { AdminContext, AuthzAdminQuery, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import type { AssignmentSubject } from '../contracts.js';
import { assignmentStore, isPlainObject, linkStore, quote, readRef, readSubject, ruleStore } from './common.js';
import type { Page } from './ports.js';

// AuthzAdmin passes a checked page; a direct caller gets the admin's default.
function pageOf(q: AuthzAdminQuery): Page {
  const p = (q as { page?: unknown }).page;
  if (p === undefined) return { limit: 50, offset: 0 };
  if (!isPlainObject(p) || !Number.isInteger(p.limit) || !Number.isInteger(p.offset) || (p.limit as number) < 0 || (p.offset as number) < 0) throw new AuthzAdminFailure('invalid_query', 'page must be { limit, offset } with non-negative integers', 'page');
  return { limit: p.limit as number, offset: p.offset as number };
}

function scopeOf(q: AuthzAdminQuery): ResourceRef | undefined {
  return q.scope === undefined ? undefined : asQuery(() => readRef(q.scope, 'scope'));
}

/** A malformed filter is a malformed query, not a malformed command. */
function asQuery<T>(read: () => T): T {
  try {
    return read();
  } catch (e) {
    if (e instanceof AuthzAdminFailure && e.code === 'invalid_command') throw new AuthzAdminFailure('invalid_query', e.message, e.field);
    throw e;
  }
}

/** list() of assignments, links (never a token or its hash) and rules, from the domain's Admin*Store. */
@Singleton()
@Injectable(AuthzAdminReader)
export class RbacAdminReader extends AuthzAdminReader {
  readonly kinds = ['assignments', 'links', 'rules'] as const;

  async list(q: AuthzAdminQuery, ctx: AdminContext): Promise<{ items: readonly unknown[]; total: number }> {
    switch (q.kind) {
      case 'assignments': {
        const page = pageOf(q);
        const scope = scopeOf(q);
        const subject: AssignmentSubject | undefined = q.subject === undefined ? undefined : asQuery(() => readSubject(q.subject, 'subject'));
        if (q.role !== undefined && (typeof q.role !== 'string' || q.role === '')) throw new AuthzAdminFailure('invalid_query', 'role must be a non-empty string', 'role');
        if (q.includeExpired !== undefined && typeof q.includeExpired !== 'boolean') throw new AuthzAdminFailure('invalid_query', 'includeExpired must be a boolean', 'includeExpired');
        return (await assignmentStore(ctx)).find({ scope, subject, role: q.role, includeExpired: q.includeExpired === true, at: ctx.now }, page);
      }
      case 'links': {
        const { items, total } = await (await linkStore(ctx)).find({ scope: scopeOf(q) }, pageOf(q));
        // Only LinkDef fields: a store's own row type may carry the hash.
        return { items: items.map((l) => ({ id: l.id, scope: l.scope, expiresAt: l.expiresAt ?? null, attributes: l.attributes, ...(l.createdBy ? { createdBy: l.createdBy } : {}) })), total };
      }
      case 'rules':
        return (await ruleStore(ctx)).find({ scope: scopeOf(q) }, pageOf(q));
      default:
        throw new AuthzAdminFailure('not_found', `RbacAdminReader does not answer ${quote(q.kind)}`, 'kind');
    }
  }
}
