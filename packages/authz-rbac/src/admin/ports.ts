import type { AuthzTx, PrincipalRef, ResourceRef } from '@spinajs/authz';

import { AssignmentStore, LinkStore, RuleStore } from '../contracts.js';
import type { Assignment, AssignmentSubject, LinkDef, RuleDef } from '../contracts.js';

export interface AssignmentQuery {
  readonly scope?: ResourceRef;
  readonly subject?: AssignmentSubject;
  readonly role?: string;
  readonly includeExpired?: boolean;
  readonly at: Date;
}

export interface Page {
  readonly limit: number;
  readonly offset: number;
}

/** What the RBAC write handlers of AuthzAdmin write through; every write runs inside the batch transaction. */
export abstract class AdminAssignmentStore extends AssignmentStore {
  /** The same (subject, role, scope), expired rows included, updates tags and expiry and keeps the id. */
  abstract assign(a: Omit<Assignment, 'id' | 'source'>, actor: PrincipalRef, tx: AuthzTx): Promise<Assignment>;
  abstract revoke(id: string, actor: PrincipalRef, tx: AuthzTx): Promise<void>;
  abstract update(id: string, patch: { readonly tags?: readonly string[]; readonly expiresAt?: Date | null }, actor: PrincipalRef, tx: AuthzTx): Promise<Assignment>;
  abstract find(q: AssignmentQuery, page?: Page): Promise<{ items: readonly Assignment[]; total: number }>;
  /** Live rows whose subject has one of these keys (subjectKeyOf): how the membership closure walks up. */
  abstract forSubjectKeys(keys: readonly string[], at: Date): Promise<readonly Assignment[]>;
  /** Removes every row AT the scope (not rows whose subject is a set at it); returns the removed rows. */
  abstract forgetScope(scope: ResourceRef, tx: AuthzTx): Promise<readonly Assignment[]>;
}

/** Links and their assignments (subject `link:<id>`); the store writes both. */
export abstract class AdminLinkStore extends LinkStore {
  abstract create(l: Omit<LinkDef, 'id'>, grant: { role: string; tags?: readonly string[] }, actor: PrincipalRef, tx: AuthzTx): Promise<{ link: LinkDef; token: string }>;
  /** Also removes the link's assignments. */
  abstract revoke(id: string, actor: PrincipalRef, tx: AuthzTx): Promise<void>;
  abstract update(id: string, patch: { readonly expiresAt?: Date | null; readonly attributes?: Readonly<Record<string, unknown>> }, actor: PrincipalRef, tx: AuthzTx): Promise<LinkDef>;
  abstract find(q: { readonly scope?: ResourceRef }, page?: Page): Promise<{ items: readonly LinkDef[]; total: number }>;
  /** Removes the links AT the scope (expired ones too) and their assignments; returns the removed links. */
  abstract forgetScope(scope: ResourceRef, tx: AuthzTx): Promise<readonly LinkDef[]>;
}

export abstract class AdminRuleStore extends RuleStore {
  /** Expired rules too. */
  abstract byId(id: string): Promise<RuleDef | null>;
  /** Throws AuthzAdminFailure when the store cannot hold the rule (DB: a value longer than its column). */
  abstract assertStorable(rule: Omit<RuleDef, 'source'>): void;
  /** Insert or replace by id. */
  abstract put(rule: Omit<RuleDef, 'source'>, actor: PrincipalRef, tx: AuthzTx): Promise<void>;
  abstract delete(id: string, tx: AuthzTx): Promise<void>;
  abstract find(q: { readonly scope?: ResourceRef }, page?: Page): Promise<{ items: readonly RuleDef[]; total: number }>;
  abstract forgetScope(scope: ResourceRef, tx: AuthzTx): Promise<readonly RuleDef[]>;
}

/**
 * Optional: tells DefaultAdminGuard's last-holder check which principals are in service (typically an account
 * that is active, not banned and not deleted; the implementer decides, e.g. about expired credentials). The
 * app's identity package implements it; authz-rbac knows no accounts. Keys are `principalKey(ref)`; a ref the
 * answer leaves out is not in service.
 */
export abstract class AccountStatusSource {
  abstract inService(refs: readonly PrincipalRef[]): Promise<ReadonlyMap<string, boolean>>;
}
