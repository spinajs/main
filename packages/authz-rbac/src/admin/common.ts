import { AuthzAdminFailure, adminActor, principalKey, requireAdminService } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, PrincipalRef } from '@spinajs/authz';
import type { Class } from '@spinajs/di';

import type { AssignmentSubject } from '../contracts.js';
import { AdminAssignmentStore, AdminLinkStore, AdminRuleStore } from './ports.js';
import { copyPrincipalRef, isSetSubject } from './rows.js';

export const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const quote = (v: unknown): string => JSON.stringify(v) ?? String(v);

// ---- stores ----

const store = <T>(ctx: AdminContext, token: Class<T>): Promise<T> => requireAdminService(ctx, token, 'the RBAC write handlers of AuthzAdmin');

export const assignmentStore = (ctx: AdminContext): Promise<AdminAssignmentStore> => store(ctx, AdminAssignmentStore);
export const linkStore = (ctx: AdminContext): Promise<AdminLinkStore> => store(ctx, AdminLinkStore);
export const ruleStore = (ctx: AdminContext): Promise<AdminRuleStore> => store(ctx, AdminRuleStore);

// ---- link subjects ----

export const LINK_TYPE = 'link';

export const isLinkSubject = (s: AssignmentSubject): boolean => !isSetSubject(s) && s.type === LINK_TYPE;

/** A link's grant belongs to the link: only link.* (authz:links.manage) writes it. */
export function refuseLinkSubject(s: AssignmentSubject, field: string): void {
  if (isLinkSubject(s)) throw new AuthzAdminFailure('conflict', `${field} is a share link; its grant changes through link.update and link.revoke`, field);
}

// ---- results ----

export function actorRef(ctx: AdminContext): PrincipalRef {
  return copyPrincipalRef(adminActor(ctx));
}

export function event(ctx: AdminContext, type: string, data: Record<string, unknown>): AuthzEvent {
  return { type, domain: ctx.domain, actor: actorRef(ctx), at: ctx.now, data };
}

/** Cache tags of an assignment's subject: members of a set are unknown, so a set flushes by role. */
export function subjectTag(s: AssignmentSubject): string {
  return isSetSubject(s) ? `role:${s.set.role}` : `subject:${principalKey(s)}`;
}

export const linkTags = (id: string): string[] => [`link:${id}`, subjectTag({ type: 'link', id })];
