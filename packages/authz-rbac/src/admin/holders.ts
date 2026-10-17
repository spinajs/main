import { AuthzAdminFailure, AuthzConfigError, GLOBAL, compilePermissionGlob, resourceKey } from '@spinajs/authz';
import type { AdminContext, AuthzService, Permission, ResourceRef } from '@spinajs/authz';

import { MembershipStore } from '../contracts.js';
import type { Assignment, AssignmentSubject, ResourcePattern } from '../contracts.js';
import { RbacModel } from '../model/model.js';
import { compilePattern, patternFilter } from '../model/patterns.js';
import { parsePrincipalSubjectKey, parseSetKey } from '../model/sets/keys.js';
import { modelTables } from '../model/service.js';
import { subjectKeyOf } from '../stores/columns.js';
import { assignmentStore, honoured, ladderAppliesAt, optionalStore, rankOf, roleClosure, roleIndex } from './common.js';
import type { RoleIndex } from './common.js';
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
  /** An introspection check (never audited or cached) as this principal, built from its ref alone; absent for a set, a wildcard or a link subject. */
  readonly decision?: { readonly allowed: boolean; readonly conditional: boolean; readonly reason?: string };
}

/** Roles whose grants give `permission` (extends, ladders and permission implies are in the grant index), plus every role that implies one of them. */
export function grantingRoles(model: RbacModel, permission: Permission): ReadonlySet<string> {
  return grantingRolesAt(model, permission).ancestors;
}

/**
 * The granting roles split by where the assignment sits relative to the resource: `self` for an assignment
 * on the resource itself (an implied role counts only `self-and-descendants`), `ancestors` for one on an
 * ancestor or $global (every implied role counts).
 */
export function grantingRolesAt(model: RbacModel, permission: Permission): { readonly self: ReadonlySet<string>; readonly ancestors: ReadonlySet<string> } {
  const index = model.grantIndex();
  const { implies } = modelTables(model);
  const names = [...model.roleGraph().names];
  const direct = names.filter((r) => index.grants(r, permission).length > 0);
  const close = (reaches: (at: 'self-and-descendants' | 'descendants') => boolean): ReadonlySet<string> => {
    const out = new Set(direct);
    for (let grew = true; grew; ) {
      grew = false;
      for (const r of names) {
        if (!out.has(r) && implies?.of(r).some((e) => out.has(e.role) && reaches(e.at))) {
          out.add(r);
          grew = true;
        }
      }
    }
    return out;
  };
  return { self: close((at) => at === 'self-and-descendants'), ancestors: close(() => true) };
}

/**
 * Whether a row can give `permissions` at `scope` by what is static: the role may be held at the row's
 * scope type, and a grant of its closure meets `grantedAt`, the ladder's `resourceTypes` and `on`.
 * `requiresTag` and `relation` are decided per principal, so such a grant stays.
 */
function mayGrantAt(roles: RoleIndex, permissions: readonly Permission[], row: Assignment, scope: ResourceRef, path: readonly ResourceRef[]): boolean {
  if (!honoured(roles, row)) return false;
  const here = resourceKey(row.scope) === resourceKey(scope);
  const entries = heldRoles(roles, row.role, here);
  return roleClosure(roles, row.role, here ? 'same-scope' : 'all').defs.some((d) => {
    if (d.deny === true) return false;
    const ladder = roles.ladderOf(d.name);
    if (ladder !== undefined && !ladderAppliesAt(roles, ladder, scope)) return false;
    return d.grants.some((g) => {
      if (!permissions.some((p) => compilePermissionGlob(g.permission)(p))) return false;
      if (g.grantedAt !== undefined) {
        if (!g.grantedAt.includes(row.scope.type)) return false;
        // The model gives each implied role its own entry at the row's scope, so any of them can supply the rank.
        if (ladder !== undefined && !entries.some((e) => roles.ladderOf(e) === ladder && rankOf(roles, ladder, e) >= rankOf(roles, ladder, d.name))) return false;
      }
      return g.on === undefined || g.on.some((p) => patternMayAdmit(p, scope, path));
    });
  });
}

/** The role and what it reaches through implies and extends (not through ladder rank): the roles a row may be counted as. */
function heldRoles(roles: RoleIndex, role: string, here: boolean): readonly string[] {
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const def = roles.roles.get(name);
    for (const e of def?.extends ?? []) visit(e);
    for (const i of def?.implies ?? []) if (!here || i.at === 'self-and-descendants') visit(i.role);
  };
  visit(role);
  return [...seen];
}

function patternMayAdmit(pattern: ResourcePattern, scope: ResourceRef, path: readonly ResourceRef[]): boolean {
  const p = compilePattern(pattern, 'holders');
  // A {principal.*} template is substituted per principal; only the type of a glob is known here.
  if (p.id?.some((part) => typeof part !== 'string')) return !p.glob || p.type === scope.type;
  const principal = { type: 'user', id: '', authenticated: true, source: 'holders', attributes: {} };
  return patternFilter(p, { resource: scope, path, principal }).op !== 'false';
}

const VERIFY_CHUNK = 16;
const MEMBERS_CONCURRENCY = 8;
const READ_CONCURRENCY = 8;
/** A page verifies each of its principals with one fresh inspect, so a larger page is refused. */
export const MAX_HOLDERS_PAGE = 100;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function listHolders(q: HoldersQuery, ctx: AdminContext): Promise<{ items: readonly Holder[]; total: number }> {
  const model = ctx.authz.models().find((m): m is RbacModel => m instanceof RbacModel);
  if (!model) throw new AuthzConfigError(`Authz domain ${JSON.stringify(ctx.domain)}: a holders query needs an RbacModel among the domain's models`);
  if (typeof ctx.authz.ancestors !== 'function') throw new AuthzConfigError(`Authz domain ${JSON.stringify(ctx.domain)}: a holders query needs an AuthzService with ancestors()`);
  if (typeof ctx.authz.inspect !== 'function') throw new AuthzConfigError(`Authz domain ${JSON.stringify(ctx.domain)}: a holders query needs an AuthzService with inspect()`);
  if (q.page.limit > MAX_HOLDERS_PAGE) throw new AuthzAdminFailure('invalid_query', `page.limit must be at most ${MAX_HOLDERS_PAGE}`, 'page.limit');
  const def = model.permissions().get(q.permission);
  if (def === undefined) throw new AuthzAdminFailure('invalid_query', `unknown permission ${JSON.stringify(q.permission)}`, 'permission');
  // ancestors() answers [ref, GLOBAL] for an unregistered type, so the type has to be vetted here.
  if (q.scope.type !== GLOBAL.type && !def.types.includes(q.scope.type)) throw new AuthzAdminFailure('invalid_query', `${q.permission} is not checked on ${JSON.stringify(q.scope.type)} resources`, 'scope');
  const path = await ctx.authz.ancestors(q.scope);
  if (path === null) throw new AuthzAdminFailure('not_found', `unknown resource ${resourceKey(q.scope)}`, 'scope');

  const roleSets = grantingRolesAt(model, q.permission);
  const roles = await roleIndex(ctx);
  const permissions = [q.permission, ...model.permissions().impliedBy(q.permission)];
  const store = await assignmentStore(ctx);
  const found = new Map<string, { readonly subject: AssignmentSubject; readonly via: HolderVia[] }>();
  const add = (subject: AssignmentSubject, via: HolderVia) => {
    const key = subjectKeyOf(subject);
    const entry = found.get(key) ?? { subject, via: [] };
    entry.via.push(Object.freeze(via));
    found.set(key, entry);
  };
  for (const [i, scope] of path.entries()) {
    const qualifying = i === 0 ? roleSets.self : roleSets.ancestors;
    const reads = await mapLimit([...qualifying], READ_CONCURRENCY, (role) => store.find({ scope, role, at: ctx.now }));
    for (const { items } of reads) for (const a of items) if (mayGrantAt(roles, permissions, a, q.scope, path)) add(a.subject, { role: a.role, scope: a.scope, assignment: a.id });
  }

  if (q.expandSets) {
    const membership = await optionalStore(ctx, MembershipStore);
    if (!membership) throw new AuthzAdminFailure('invalid_query', 'expandSets needs a MembershipStore in this domain', 'expandSets');
    const sets = [...found.values()].filter((h) => isSetSubject(h.subject));
    // membersOf is the transitive closure, so members of nested sets are listed directly.
    const members = await mapLimit(sets, MEMBERS_CONCURRENCY, (h) => membership.membersOf(subjectKeyOf(h.subject), ctx.now));
    sets.forEach(({ subject, via }, i) => {
      if (!isSetSubject(subject)) return;
      for (const key of members[i]) {
        if (parseSetKey(key) !== undefined) continue;
        const member = parsePrincipalSubjectKey(key);
        if (member === undefined) continue;
        for (const v of via) add(member, { ...v, set: subject.set });
      }
    });
  }

  const all = [...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, h]) => h);
  const page = all.slice(q.page.offset, q.page.offset + q.page.limit);
  const items: Holder[] = [];
  for (let i = 0; i < page.length; i += VERIFY_CHUNK) {
    items.push(...(await Promise.all(page.slice(i, i + VERIFY_CHUNK).map(async (h) => Object.freeze({ subject: h.subject, via: Object.freeze([...h.via]), ...(await decisionOf(ctx.authz, h.subject, q)) })))));
  }
  return { items: Object.freeze(items), total: all.length };
}

async function decisionOf(authz: AuthzService, subject: AssignmentSubject, q: HoldersQuery): Promise<Pick<Holder, 'decision'>> {
  // A link's ceiling, expiry and attributes are not in its ref, so a check built from the ref alone would misstate it.
  if (isSetSubject(subject) || subject.id === '*' || subject.type === 'link') return {};
  const principal = Object.freeze({ type: subject.type, id: subject.id, authenticated: subject.type !== 'anonymous' && subject.type !== 'unattended', source: 'holders', attributes: Object.freeze({}) });
  const d = await authz.inspect!({ principal, permission: q.permission, resource: q.scope });
  return { decision: Object.freeze({ allowed: d.allowed, conditional: d.allowed && d.residual?.op !== 'true', ...(d.reason ? { reason: d.reason.code } : {}) }) };
}
