import type { Assignment, AssignmentSubject, LinkDef, Policy, RuleDef } from './data.js';
import type { Permission } from './permission.js';
import type { Principal, PrincipalRef, ResourceRef } from './principal.js';
import type { AuthzService } from './service.js';

export type AuthzCommand =
  // assignments (principals and subject sets)
  | {
      readonly kind: 'assignment.grant';
      readonly subject: AssignmentSubject;
      readonly role: string;
      readonly scope: ResourceRef;
      readonly tags?: readonly string[];
      readonly expiresAt?: Date | null;
      readonly replaceLadder?: boolean; // revoke the subject's other roles of the same ladder at this scope
    }
  | { readonly kind: 'assignment.revoke'; readonly id: string }
  | { readonly kind: 'assignment.revokeWhere'; readonly scope: ResourceRef; readonly subject?: AssignmentSubject; readonly role?: string }
  | { readonly kind: 'assignment.setTags' | 'assignment.addTags' | 'assignment.removeTags'; readonly id: string; readonly tags: readonly string[] }
  | { readonly kind: 'assignment.setExpiry'; readonly id: string; readonly expiresAt: Date | null }
  // subject sets: sugar over assignments of subjectSet roles (group.member at group:G, org.member at org:O)
  | { readonly kind: 'set.addMember'; readonly set: { readonly role: string; readonly scope: ResourceRef }; readonly member: PrincipalRef; readonly expiresAt?: Date | null }
  | { readonly kind: 'set.removeMember'; readonly set: { readonly role: string; readonly scope: ResourceRef }; readonly member: PrincipalRef }
  // share links
  | { readonly kind: 'link.create'; readonly scope: ResourceRef; readonly role: string; readonly tags?: readonly string[]; readonly expiresAt?: Date | null; readonly attributes?: Readonly<Record<string, unknown>> }
  | { readonly kind: 'link.update'; readonly id: string; readonly expiresAt?: Date | null; readonly attributes?: Readonly<Record<string, unknown>>; readonly role?: string; readonly tags?: readonly string[] }
  | { readonly kind: 'link.revoke'; readonly id: string }
  // RBAC rules (scoped rows; config rules stay in config)
  | { readonly kind: 'rule.put'; readonly rule: Omit<RuleDef, 'source'> } // insert or replace by id; must be in SQL form (D24)
  | { readonly kind: 'rule.delete'; readonly id: string }
  // ABAC policies (scoped rows)
  | { readonly kind: 'policy.put'; readonly policy: Omit<Policy, 'source'> }
  | { readonly kind: 'policy.delete'; readonly id: string }
  // scope attributes
  | { readonly kind: 'scope.setAttributes'; readonly scope: ResourceRef; readonly patch: Readonly<Record<string, unknown>> } // deep merge; null deletes a path
  | { readonly kind: 'scope.replaceAttributes'; readonly scope: ResourceRef; readonly attributes: Readonly<Record<string, unknown>> }
  // lifecycle of a scope node (project or file deleted)
  | { readonly kind: 'scope.forget'; readonly scope: ResourceRef }; // assignments, links, rules, policies and attributes AT this scope

export type AuthzCommandResult = { readonly ok: true; readonly kind: AuthzCommand['kind']; readonly id?: string; readonly token?: string /* link.create only, shown once */; readonly affected: number } | { readonly ok: false; readonly kind: AuthzCommand['kind']; readonly error: AuthzAdminError };

export interface AuthzAdminError {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
}
// codes: unknown_role, not_assignable, wrong_scope_type, unknown_ladder, unknown_permission, rule_not_compilable,
//        invalid_attributes, not_found, forbidden, escalation, last_holder, self_lockout, protected_role, conflict

/** Thrown by write handlers, AdminGuard and AuthzCommandValidator; AuthzAdmin reports it as an AuthzAdminError. */
export class AuthzAdminFailure extends Error {
  readonly code: string;
  readonly field?: string;

  constructor(code: string, message?: string, field?: string, options?: ErrorOptions) {
    super(message ?? code, options);
    this.name = new.target.name;
    this.code = code;
    this.field = field;
  }
}

export interface AuthzAdminOptions {
  readonly reason?: string; // goes to audit
  readonly idempotencyKey?: string; // a retried batch with the same key returns the first result
  readonly dryRun?: boolean; // validate and guard, then roll back (admin UIs)
}

/**
 * Root singleton; per-domain variants via (await AuthzDomains.service(name)).admin().
 * The typed sugar methods throw AuthzAdminFailure with the failed result's error code (and field) instead of returning it.
 */
export abstract class AuthzAdmin {
  /** All commands in one transaction; the first failure rolls back the batch and is reported with its index. */
  abstract execute(actor: Principal, commands: readonly AuthzCommand[], opts?: AuthzAdminOptions): Promise<readonly AuthzCommandResult[]>;
  // typed sugar over execute([one command])
  abstract assign(actor: Principal, a: Omit<Extract<AuthzCommand, { kind: 'assignment.grant' }>, 'kind'>, opts?: AuthzAdminOptions): Promise<Assignment>;
  abstract revoke(actor: Principal, id: string, opts?: AuthzAdminOptions): Promise<void>;
  abstract createLink(actor: Principal, l: Omit<Extract<AuthzCommand, { kind: 'link.create' }>, 'kind'>, opts?: AuthzAdminOptions): Promise<{ link: LinkDef; token: string }>;
  abstract revokeLink(actor: Principal, id: string, opts?: AuthzAdminOptions): Promise<void>;
  abstract setTags(actor: Principal, assignmentId: string, tags: readonly string[], opts?: AuthzAdminOptions): Promise<void>;
  abstract putRule(actor: Principal, rule: Omit<RuleDef, 'source'>, opts?: AuthzAdminOptions): Promise<void>;
  abstract deleteRule(actor: Principal, id: string, opts?: AuthzAdminOptions): Promise<void>;
  abstract putPolicy(actor: Principal, policy: Omit<Policy, 'source'>, opts?: AuthzAdminOptions): Promise<void>;
  abstract deletePolicy(actor: Principal, id: string, opts?: AuthzAdminOptions): Promise<void>;
  abstract setScopeAttributes(actor: Principal, scope: ResourceRef, patch: Readonly<Record<string, unknown>>, opts?: AuthzAdminOptions): Promise<void>;
  abstract forgetScope(actor: Principal, scope: ResourceRef, opts?: AuthzAdminOptions): Promise<void>;
  // reads for admin UIs (guarded by the matching ':read' permission)
  abstract list(actor: Principal, q: AuthzAdminQuery): Promise<{ items: readonly unknown[]; total: number }>;
}

export type AuthzAdminQuery = { readonly kind: 'assignments'; readonly scope?: ResourceRef; readonly subject?: AssignmentSubject; readonly role?: string; readonly includeExpired?: boolean; readonly page?: { limit: number; offset: number } } | { readonly kind: 'links' | 'rules' | 'policies'; readonly scope?: ResourceRef; readonly page?: { limit: number; offset: number } } | { readonly kind: 'attributes'; readonly scope: ResourceRef };

/** One per command kind family; registered by the model that owns the data (RBAC: assignment, set, link, rule; ABAC: policy; core: scope). */
export abstract class AuthzWriteHandler {
  abstract readonly kinds: readonly AuthzCommand['kind'][];
  abstract validate(c: AuthzCommand, ctx: AdminContext): Promise<void>; // throws AuthzAdminFailure(code)
  abstract permission(c: AuthzCommand): { permission: Permission; resource: ResourceRef }; // what the actor must hold
  abstract apply(c: AuthzCommand, ctx: AdminContext, tx: AuthzTx): Promise<{ id?: string; token?: string; affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }>;
}

/** DefaultAdminGuard implements it; was RoleGuard. */
export abstract class AdminGuard {
  abstract check(actor: Principal, c: AuthzCommand, ctx: AdminContext): Promise<void>; // escalation, last holder, self-lockout, protected roles
}

/** App hook, Array.ofType; e.g. refuse external invites when the product rule says so. */
export abstract class AuthzCommandValidator {
  abstract validate(actor: Principal, c: AuthzCommand, ctx: AdminContext): Promise<void>;
}

export interface AuthzEvent {
  readonly type: string;
  readonly domain: string;
  readonly actor: PrincipalRef;
  readonly at: Date;
  readonly data: Readonly<Record<string, unknown>>;
}

export abstract class AuthzEventSink {
  abstract publish(events: readonly AuthzEvent[]): Promise<void>; // after commit; Array.ofType
}

export interface AuthzTx {
  readonly driver: unknown; // the ORM transaction handle, opaque to the core
}

export interface AdminContext {
  readonly domain: string;
  readonly now: Date;
  readonly authz: AuthzService;
  readonly reason?: string;
}
