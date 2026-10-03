import { AuthzAdminFailure, AuthzWriteHandler } from '@spinajs/authz';
import type { AdminContext, AppliedRow, AuthzCommand, AuthzEvent, AuthzTx, Permission, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import type { Assignment, AssignmentSubject } from '../contracts.js';
import { actorRef, assignmentStore, checkGrantable, event, invalid, isLinkSubject, plannedRemovals, quote, readFutureExpiry, readId, readOptionalTags, readPrincipal, readScope, readSubject, readTags, refuseLinkSubject, roleIndex, subjectTag } from './common.js';
import type { RoleIndex } from './common.js';

type Cmd<K extends AuthzCommand['kind']> = Extract<AuthzCommand, { kind: K }>;
type Applied = { id?: string; affected: number; tags: readonly string[]; events: readonly AuthzEvent[] } & AppliedRow;

const MANAGE: Permission = 'authz:assignments.manage';

const assigned = (ctx: AdminContext, a: Assignment): AuthzEvent => event(ctx, 'RoleAssigned', { id: a.id, subject: a.subject, role: a.role, scope: a.scope, tags: a.tags ?? [], expiresAt: a.expiresAt ?? null });
const revoked = (ctx: AdminContext, a: Assignment): AuthzEvent => event(ctx, 'RoleRevoked', { id: a.id, subject: a.subject, role: a.role, scope: a.scope });
const changed = (ctx: AdminContext, a: Assignment): AuthzEvent => event(ctx, 'AssignmentChanged', { id: a.id, subject: a.subject, role: a.role, scope: a.scope, tags: a.tags ?? [], expiresAt: a.expiresAt ?? null });

/** With `roles` (grants), the set role must be a subject set role; removals check the shape only, so rows of a role dropped from config can go. */
function setOf(c: Cmd<'set.addMember' | 'set.removeMember'>, roles?: RoleIndex): { role: string; scope: ResourceRef } {
  const set: unknown = c.set;
  if (set === null || typeof set !== 'object') throw invalid('set', 'set must be { role, scope }');
  const s = set as Record<string, unknown>;
  const scope = readScope(s.scope, 'set.scope');
  const role = readId(s.role, 'set.role');
  if (roles && roles.roles.get(role)?.subjectSet !== true) throw new AuthzAdminFailure('unknown_role', `${quote(role)} is not a subject set role`, 'set.role');
  return { role, scope };
}

/** assignment.* and set.* (subject sets are assignments of subjectSet roles). */
@Singleton()
@Injectable(AuthzWriteHandler)
export class RbacAssignmentHandler extends AuthzWriteHandler {
  readonly kinds = ['assignment.grant', 'assignment.revoke', 'assignment.revokeWhere', 'assignment.setTags', 'assignment.addTags', 'assignment.removeTags', 'assignment.setExpiry', 'set.addMember', 'set.removeMember'] as const;

  async validate(c: AuthzCommand, ctx: AdminContext): Promise<void> {
    switch (c.kind) {
      case 'assignment.grant':
        await this.grantOf(c, ctx);
        return;
      case 'assignment.revoke':
        readId(c.id);
        return;
      case 'assignment.revokeWhere':
        this.whereOf(c);
        return;
      case 'assignment.setTags':
      case 'assignment.addTags':
      case 'assignment.removeTags':
        readId(c.id);
        readTags(c.tags);
        return;
      case 'assignment.setExpiry':
        readId(c.id);
        if (c.expiresAt === undefined) throw invalid('expiresAt', 'expiresAt must be a Date or null');
        readFutureExpiry(c.expiresAt, ctx);
        return;
      case 'set.addMember':
        await this.memberOf(c, ctx);
        return;
      case 'set.removeMember':
        setOf(c);
        refuseLinkSubject(readPrincipal(c.member, 'member'), 'member');
        return;
      default:
        throw new AuthzAdminFailure('not_found', `RbacAssignmentHandler does not handle ${quote((c as AuthzCommand).kind)}`);
    }
  }

  async permission(c: AuthzCommand, ctx: AdminContext): Promise<{ permission: Permission; resource: ResourceRef }> {
    switch (c.kind) {
      case 'assignment.grant':
      case 'assignment.revokeWhere':
        return { permission: MANAGE, resource: readScope(c.scope, 'scope') };
      case 'set.addMember':
      case 'set.removeMember':
        return { permission: MANAGE, resource: readScope((c.set as { scope?: unknown } | undefined)?.scope, 'set.scope') };
      default:
        return { permission: MANAGE, resource: (await this.row(c as Cmd<'assignment.revoke'>, ctx)).scope };
    }
  }

  async apply(c: AuthzCommand, ctx: AdminContext, tx: AuthzTx): Promise<Applied> {
    const store = await assignmentStore(ctx);
    const actor = actorRef(ctx);
    switch (c.kind) {
      case 'assignment.grant': {
        const g = await this.grantOf(c, ctx);
        const events: AuthzEvent[] = [];
        const { revoke } = await plannedRemovals(c, ctx);
        for (const other of revoke) {
          await store.revoke(other.id, actor, tx);
          events.push(revoked(ctx, other));
        }
        const row = await store.assign({ subject: g.subject, role: g.role, scope: g.scope, tags: g.tags, expiresAt: g.expiresAt }, actor, tx);
        events.push(assigned(ctx, row));
        return { id: row.id, affected: revoke.length + 1, tags: [subjectTag(row.subject)], events, row };
      }
      case 'assignment.revoke': {
        const row = await this.row(c, ctx);
        await store.revoke(row.id, actor, tx);
        return { id: row.id, affected: 1, tags: [subjectTag(row.subject)], events: [revoked(ctx, row)] };
      }
      case 'assignment.revokeWhere': {
        this.whereOf(c);
        const items = (await plannedRemovals(c, ctx)).revoke;
        for (const a of items) await store.revoke(a.id, actor, tx);
        return { affected: items.length, tags: [...new Set(items.map((a) => subjectTag(a.subject)))], events: items.map((a) => revoked(ctx, a)) };
      }
      case 'assignment.setTags':
      case 'assignment.addTags':
      case 'assignment.removeTags': {
        const row = await this.row(c, ctx);
        const given = readTags(c.tags);
        const old = row.tags ?? [];
        const tags = c.kind === 'assignment.setTags' ? given : c.kind === 'assignment.addTags' ? [...old, ...given] : old.filter((t) => !given.includes(t));
        const next = await store.update(row.id, { tags }, actor, tx);
        return { id: next.id, affected: 1, tags: [subjectTag(next.subject)], events: [changed(ctx, next)] };
      }
      case 'assignment.setExpiry': {
        const row = await this.row(c, ctx);
        const next = await store.update(row.id, { expiresAt: readFutureExpiry(c.expiresAt, ctx) ?? null }, actor, tx);
        return { id: next.id, affected: 1, tags: [subjectTag(next.subject)], events: [changed(ctx, next)] };
      }
      case 'set.addMember': {
        const m = await this.memberOf(c, ctx);
        const row = await store.assign({ subject: m.member, role: m.role, scope: m.scope, tags: [], expiresAt: m.expiresAt }, actor, tx);
        return { id: row.id, affected: 1, tags: [subjectTag(row.subject)], events: [assigned(ctx, row)] };
      }
      case 'set.removeMember': {
        const set = setOf(c);
        const member = readPrincipal(c.member, 'member');
        refuseLinkSubject(member, 'member');
        const items = (await plannedRemovals(c, ctx)).revoke;
        if (items.length === 0) throw new AuthzAdminFailure('not_found', `${quote(member)} is not a member of ${quote(set.role)} at the set scope`, 'member');
        for (const a of items) await store.revoke(a.id, actor, tx);
        return { id: items[0].id, affected: items.length, tags: [subjectTag(member)], events: items.map((a) => revoked(ctx, a)) };
      }
      default:
        throw new AuthzAdminFailure('not_found', `RbacAssignmentHandler does not handle ${quote((c as AuthzCommand).kind)}`);
    }
  }

  private async grantOf(c: Cmd<'assignment.grant'>, ctx: AdminContext): Promise<{ subject: AssignmentSubject; role: string; scope: ResourceRef; tags: string[]; expiresAt: Date | null; replaceLadder: boolean }> {
    const roles = await roleIndex(ctx);
    const scope = readScope(c.scope, 'scope');
    const subject = readSubject(c.subject, 'subject', roles);
    refuseLinkSubject(subject, 'subject');
    const def = checkGrantable(roles, c.role, scope);
    const tags = readOptionalTags(c.tags) ?? [];
    const expiresAt = readFutureExpiry(c.expiresAt, ctx) ?? null;
    if (c.replaceLadder !== undefined && typeof c.replaceLadder !== 'boolean') throw invalid('replaceLadder', 'replaceLadder must be a boolean');
    if (c.replaceLadder === true && roles.ladderOf(def.name) === undefined) throw new AuthzAdminFailure('unknown_ladder', `replaceLadder needs a ladder role; ${quote(def.name)} is on no ladder`, 'role');
    return { subject, role: def.name, scope, tags, expiresAt, replaceLadder: c.replaceLadder === true };
  }

  private async memberOf(c: Cmd<'set.addMember'>, ctx: AdminContext): Promise<{ member: PrincipalRef; role: string; scope: ResourceRef; expiresAt: Date | null }> {
    const roles = await roleIndex(ctx);
    const set = setOf(c, roles);
    checkGrantable(roles, set.role, set.scope, 'set.role');
    const member = readPrincipal(c.member, 'member');
    refuseLinkSubject(member, 'member');
    return { member, role: set.role, scope: set.scope, expiresAt: readFutureExpiry(c.expiresAt, ctx) ?? null };
  }

  private whereOf(c: Cmd<'assignment.revokeWhere'>): { scope: ResourceRef; subject?: AssignmentSubject; role?: string } {
    const scope = readScope(c.scope, 'scope');
    const subject = c.subject === undefined ? undefined : readSubject(c.subject, 'subject');
    if (subject) refuseLinkSubject(subject, 'subject');
    return { scope, subject, role: c.role === undefined ? undefined : readId(c.role, 'role') };
  }

  /** The row an id-only command names, expired rows included. */
  private async row(c: { readonly id: unknown }, ctx: AdminContext): Promise<Assignment> {
    const id = readId(c.id);
    const row = await (await assignmentStore(ctx)).byId(id);
    if (!row) throw new AuthzAdminFailure('not_found', `no assignment ${quote(id)}`, 'id');
    if (isLinkSubject(row.subject)) throw new AuthzAdminFailure('conflict', `assignment ${quote(id)} is the grant of a share link; use link.update or link.revoke`, 'id');
    return row;
  }
}
