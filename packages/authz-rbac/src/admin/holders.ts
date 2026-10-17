import { AuthzAdminFailure, AuthzConfigError, GLOBAL, resourceKey } from '@spinajs/authz';
import type { AdminContext, AuthzService, Permission, ResourceRef } from '@spinajs/authz';

import { MembershipStore } from '../contracts.js';
import type { AssignmentSubject } from '../contracts.js';
import { RbacModel } from '../model/model.js';
import { parsePrincipalSubjectKey, parseSetKey } from '../model/sets/keys.js';
import { modelTables } from '../model/service.js';
import { subjectKeyOf } from '../stores/columns.js';
import { assignmentStore, optionalStore } from './common.js';
import { isSetSubject } from './rows.js';

export interface HoldersQuery {
  readonly permission: Permission;
  readonly scope: ResourceRef;
  readonly expandSets: boolean;
  readonly page: { readonly limit: number; readonly offset: number };
}

export interface HolderVia {
  readonly role: string;
  readonly scope: ResourceRef;
  readonly assignment: string;
  /** Present when the subject holds the role as a member of this set. */
  readonly set?: { readonly role: string; readonly scope: ResourceRef };
}

export interface Holder {
  readonly subject: AssignmentSubject;
  readonly via: readonly HolderVia[];
  /** A fresh check as this principal, built from its ref alone; absent for a set or a wildcard subject. */
  readonly decision?: { readonly allowed: boolean; readonly conditional: boolean; readonly reason?: string };
}

/** Roles whose grants give `permission` (extends, ladders and permission implies are in the grant index), plus every role that implies one of them. */
export function grantingRoles(model: RbacModel, permission: Permission): ReadonlySet<string> {
  const index = model.grantIndex();
  const { implies } = modelTables(model);
  const names = [...model.roleGraph().names];
  const out = new Set(names.filter((r) => index.grants(r, permission).length > 0));
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of names) {
      if (!out.has(r) && implies?.of(r).some((e) => out.has(e.role))) {
        out.add(r);
        grew = true;
      }
    }
  }
  return out;
}

export async function listHolders(q: HoldersQuery, ctx: AdminContext): Promise<{ items: readonly Holder[]; total: number }> {
  const model = ctx.authz.models().find((m): m is RbacModel => m instanceof RbacModel);
  if (!model) throw new AuthzConfigError(`Authz domain ${JSON.stringify(ctx.domain)}: a holders query needs an RbacModel among the domain's models`);
  if (typeof ctx.authz.ancestors !== 'function') throw new AuthzConfigError(`Authz domain ${JSON.stringify(ctx.domain)}: a holders query needs an AuthzService with ancestors()`);
  const def = model.permissions().get(q.permission);
  if (def === undefined) throw new AuthzAdminFailure('invalid_query', `unknown permission ${JSON.stringify(q.permission)}`, 'permission');
  // ancestors() answers [ref, GLOBAL] for an unregistered type, so the type has to be vetted here.
  if (q.scope.type !== GLOBAL.type && !def.types.includes(q.scope.type)) throw new AuthzAdminFailure('invalid_query', `${q.permission} is not checked on ${JSON.stringify(q.scope.type)} resources`, 'scope');
  const path = await ctx.authz.ancestors(q.scope);
  if (path === null) throw new AuthzAdminFailure('not_found', `unknown resource ${resourceKey(q.scope)}`, 'scope');

  const roles = grantingRoles(model, q.permission);
  const store = await assignmentStore(ctx);
  const found = new Map<string, { readonly subject: AssignmentSubject; readonly via: HolderVia[] }>();
  const add = (subject: AssignmentSubject, via: HolderVia) => {
    const key = subjectKeyOf(subject);
    const entry = found.get(key) ?? { subject, via: [] };
    entry.via.push(Object.freeze(via));
    found.set(key, entry);
  };
  for (const scope of path) {
    const { items } = await store.find({ scope, at: ctx.now });
    for (const a of items) if (roles.has(a.role)) add(a.subject, { role: a.role, scope: a.scope, assignment: a.id });
  }

  if (q.expandSets) {
    const membership = await optionalStore(ctx, MembershipStore);
    if (!membership) throw new AuthzAdminFailure('invalid_query', 'expandSets needs a MembershipStore in this domain', 'expandSets');
    for (const { subject, via } of [...found.values()]) {
      if (!isSetSubject(subject)) continue;
      // membersOf is the transitive closure, so members of nested sets are listed directly.
      for (const key of await membership.membersOf(subjectKeyOf(subject), ctx.now)) {
        if (parseSetKey(key) !== undefined) continue;
        const member = parsePrincipalSubjectKey(key);
        if (member === undefined) continue;
        for (const v of via) add(member, { ...v, set: subject.set });
      }
    }
  }

  const all = [...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, h]) => h);
  const page = all.slice(q.page.offset, q.page.offset + q.page.limit);
  const items = await Promise.all(page.map(async (h) => Object.freeze({ subject: h.subject, via: Object.freeze([...h.via]), ...(await decisionOf(ctx.authz, h.subject, q)) })));
  return { items: Object.freeze(items), total: all.length };
}

async function decisionOf(authz: AuthzService, subject: AssignmentSubject, q: HoldersQuery): Promise<Pick<Holder, 'decision'>> {
  if (isSetSubject(subject) || subject.id === '*') return {};
  const principal = Object.freeze({ type: subject.type, id: subject.id, authenticated: subject.type !== 'anonymous' && subject.type !== 'unattended', source: 'holders', attributes: Object.freeze({}) });
  const d = await authz.check({ principal, permission: q.permission, resource: q.scope, fresh: true });
  return { decision: Object.freeze({ allowed: d.allowed, conditional: d.allowed && d.residual?.op !== 'true', ...(d.reason ? { reason: d.reason.code } : {}) }) };
}
