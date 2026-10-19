import { readExpiry, readId, readPrincipal, readScope } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, ResourceRef } from '@spinajs/authz';

import type { Assignment, AssignmentSubject } from '../contracts.js';
import { LINK_TYPE, assignmentStore, isLinkSubject, isPlainObject as isObject, linkStore } from './common.js';
import { readSubject } from './fields.js';
import { roleIndex } from './role-index.js';

export interface PlannedRemovals {
  /** Rows the command revokes. */
  readonly revoke: readonly Assignment[];
  /** Rows whose expiry the command sets to another non-null date. */
  readonly expire: readonly Assignment[];
}

const NONE: PlannedRemovals = Object.freeze({ revoke: [], expire: [] });

/**
 * The assignment rows a command revokes or re-expires, read inside the batch transaction: revoke,
 * revokeWhere, set.removeMember, setExpiry, link.update with a new role, link.revoke, and what a grant
 * or set.addMember removes besides what it grants (replaceLadder, a moved expiry). The handlers remove
 * exactly these rows, and an AdminGuard runs its removal checks on the same rows, so the two cannot
 * drift. A row the command names but the store no longer holds is left out (the handler reports it).
 */
export async function plannedRemovals(c: AuthzCommand, ctx: AdminContext): Promise<PlannedRemovals> {
  switch (c.kind) {
    case 'assignment.grant':
    case 'set.addMember':
      return grantRemovals(c, ctx);
    case 'assignment.revoke': {
      const row = await (await assignmentStore(ctx)).byId(readId(c.id));
      return row && !isLinkSubject(row.subject) ? { revoke: [row], expire: [] } : NONE;
    }
    case 'assignment.setExpiry': {
      const row = await (await assignmentStore(ctx)).byId(readId(c.id));
      const at = readExpiry(c.expiresAt) ?? null;
      return row && !isLinkSubject(row.subject) && at !== null && row.expiresAt?.getTime() !== at.getTime() ? { revoke: [], expire: [row] } : NONE;
    }
    case 'assignment.revokeWhere': {
      const scope = readScope(c.scope, 'scope');
      const subject = c.subject === undefined ? undefined : readSubject(c.subject, 'subject');
      const role = c.role === undefined ? undefined : readId(c.role, 'role');
      // A link's grant goes with its link (link.revoke, scope.forget).
      const { items } = await (await assignmentStore(ctx)).find({ scope, subject, role, at: ctx.now });
      return { revoke: items.filter((a) => !isLinkSubject(a.subject)), expire: [] };
    }
    case 'set.removeMember': {
      const set = (isObject(c.set) ? c.set : {}) as Record<string, unknown>;
      const { items } = await (await assignmentStore(ctx)).find({ scope: readScope(set.scope, 'set.scope'), subject: readPrincipal(c.member, 'member'), role: readId(set.role, 'set.role'), includeExpired: true, at: ctx.now });
      return { revoke: items, expire: [] };
    }
    case 'link.update': {
      if (c.role === undefined) return NONE;
      const items = await linkGrants(readId(c.id), ctx, true);
      // The role is part of an assignment's identity: a new one replaces the link's grant.
      return items !== undefined && readId(c.role, 'role') !== items[0]?.role ? { revoke: items, expire: [] } : NONE;
    }
    case 'link.revoke': {
      const items = await linkGrants(readId(c.id), ctx, false);
      return items !== undefined ? { revoke: items, expire: [] } : NONE;
    }
    default:
      return NONE;
  }
}

/** The grant rows of a link (at its scope only, or anywhere, as the link store drops them on revoke); undefined for an unknown link. */
export async function linkGrants(id: string, ctx: AdminContext, atScope: boolean): Promise<readonly Assignment[] | undefined> {
  const link = await (await linkStore(ctx)).byId(id);
  if (!link) return undefined;
  const { items } = await (await assignmentStore(ctx)).find({ subject: { type: LINK_TYPE, id: link.id }, ...(atScope ? { scope: link.scope } : {}), includeExpired: true, at: ctx.now });
  return items;
}

async function grantRemovals(c: Extract<AuthzCommand, { kind: 'assignment.grant' | 'set.addMember' }>, ctx: AdminContext): Promise<PlannedRemovals> {
  const roles = await roleIndex(ctx);
  const store = await assignmentStore(ctx);
  let subject: AssignmentSubject;
  let role: string;
  let scope: ResourceRef;
  let replaceLadder = false;
  if (c.kind === 'assignment.grant') {
    subject = readSubject(c.subject, 'subject');
    role = readId(c.role, 'role');
    scope = readScope(c.scope, 'scope');
    replaceLadder = c.replaceLadder === true;
  } else {
    const set = (isObject(c.set) ? c.set : {}) as Record<string, unknown>;
    subject = readPrincipal(c.member, 'member');
    role = readId(set.role, 'set.role');
    scope = readScope(set.scope, 'set.scope');
  }
  const expiresAt = readExpiry(c.expiresAt) ?? null;
  const { items } = await store.find({ scope, subject, includeExpired: true, at: ctx.now });
  const ladder = roles.ladderOf(role);
  const revoke = replaceLadder && ladder !== undefined ? items.filter((a) => a.role !== role && roles.ladderOf(a.role) === ladder) : [];
  const same = items.find((a) => a.role === role);
  const expire = same && expiresAt !== null && same.expiresAt?.getTime() !== expiresAt.getTime() ? [same] : [];
  return { revoke, expire };
}
