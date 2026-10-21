import { Exception } from '@spinajs/exceptions';
import type { ScopeAttributesQuery, ScopeForgetCommand, ScopeReplaceAttributesCommand, ScopeSetAttributesCommand } from './data.js';
import type { Permission } from './permission.js';
import type { Principal, PrincipalRef, ResourceRef } from './principal.js';
import type { AuthzService } from './service.js';

/**
 * Command kind -> command shape. A model declares its commands by augmenting this interface
 * (`declare module '@spinajs/authz' { interface AuthzCommandMap { ... } }`) and registers an AuthzWriteHandler for them.
 */
export interface AuthzCommandMap {
  'scope.setAttributes': ScopeSetAttributesCommand;
  'scope.replaceAttributes': ScopeReplaceAttributesCommand;
  'scope.forget': ScopeForgetCommand;
}

/** Every command a model declared in AuthzCommandMap; the core alone declares the scope commands. */
export type AuthzCommand = AuthzCommandMap[keyof AuthzCommandMap];

/** The command of kind K; never until a model declares K. */
export type AuthzCommandOf<K extends string> = K extends keyof AuthzCommandMap ? AuthzCommandMap[K] : never;

/** The fields of the command of kind K without `kind`, as the sugar methods of AuthzAdmin take them. */
export type AuthzCommandFields<K extends string> = Omit<AuthzCommandOf<K>, 'kind'>;

/** Kind -> the row a sugar method returns for it; authz-rbac declares the rows of assignment.grant and link.create. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled by module augmentation
export interface AuthzCommandRowMap {}

/** The row a sugar method returns for kind K; unknown until a model declares it. */
export type AuthzCommandRow<K extends string> = K extends keyof AuthzCommandRowMap ? AuthzCommandRowMap[K] : unknown;

/** Query kind -> query shape; a model adds its queries by augmentation and registers an AuthzAdminReader for them. */
export interface AuthzAdminQueryMap {
  attributes: ScopeAttributesQuery;
}

/** Every query a model declared in AuthzAdminQueryMap. */
export type AuthzAdminQuery = AuthzAdminQueryMap[keyof AuthzAdminQueryMap];

export type AuthzCommandResult = { readonly ok: true; readonly kind: AuthzCommand['kind']; readonly id?: string; readonly token?: string /* link.create only, shown once */; readonly affected: number } | { readonly ok: false; readonly kind: AuthzCommand['kind']; readonly error: AuthzAdminError };

export interface AuthzAdminError {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
}
// codes: unknown_role, not_assignable, wrong_scope_type, unknown_ladder, unknown_permission, rule_not_compilable,
//        invalid_attributes, not_found, forbidden, escalation, last_holder, self_lockout, protected_role, conflict,
//        not_list_filterable, set_cycle, set_too_deep

/** Thrown by write handlers, AdminGuard and AuthzCommandValidator; AuthzAdmin reports it as an AuthzAdminError. */
export class AuthzAdminFailure extends Exception {
  readonly code: string;
  readonly field?: string;

  constructor(code: string, message?: string, field?: string, options?: ErrorOptions) {
    // not `inner`: @spinajs/http spreads an error's own enumerable props into the response body
    super(message ?? code);
    this.name = new.target.name;
    if (options && 'cause' in options) Object.defineProperty(this, 'cause', { value: options.cause, writable: true, configurable: true });
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
 * They run the commands of the first-party models, so their types come from the model's AuthzCommandMap entries:
 * without @spinajs/authz-rbac (assign … deleteRule) or @spinajs/authz-abac (putPolicy, deletePolicy) they take never.
 */
export abstract class AuthzAdmin {
  /** All commands in one transaction; the first failure rolls back the batch and is reported with its index. */
  abstract execute(actor: Principal, commands: readonly AuthzCommand[], opts?: AuthzAdminOptions): Promise<readonly AuthzCommandResult[]>;
  // typed sugar over execute([one command])
  abstract assign(actor: Principal, a: AuthzCommandFields<'assignment.grant'>, opts?: AuthzAdminOptions): Promise<AuthzCommandRow<'assignment.grant'>>;
  abstract revoke(actor: Principal, id: string, opts?: AuthzAdminOptions): Promise<void>;
  abstract createLink(actor: Principal, l: AuthzCommandFields<'link.create'>, opts?: AuthzAdminOptions): Promise<{ link: AuthzCommandRow<'link.create'>; token: string }>;
  abstract revokeLink(actor: Principal, id: string, opts?: AuthzAdminOptions): Promise<void>;
  abstract setTags(actor: Principal, assignmentId: string, tags: readonly string[], opts?: AuthzAdminOptions): Promise<void>;
  abstract putRule(actor: Principal, rule: AuthzCommandOf<'rule.put'>['rule'], opts?: AuthzAdminOptions): Promise<void>;
  abstract deleteRule(actor: Principal, id: string, opts?: AuthzAdminOptions): Promise<void>;
  abstract putPolicy(actor: Principal, policy: AuthzCommandOf<'policy.put'>['policy'], opts?: AuthzAdminOptions): Promise<void>;
  abstract deletePolicy(actor: Principal, id: string, opts?: AuthzAdminOptions): Promise<void>;
  abstract setScopeAttributes(actor: Principal, scope: ResourceRef, patch: Readonly<Record<string, unknown>>, opts?: AuthzAdminOptions): Promise<void>;
  abstract forgetScope(actor: Principal, scope: ResourceRef, opts?: AuthzAdminOptions): Promise<void>;
  // reads for admin UIs (guarded by the matching ':read' permission)
  abstract list(actor: Principal, q: AuthzAdminQuery): Promise<{ items: readonly unknown[]; total: number; next?: string }>;
}


/** One per command kind family; registered by the model that owns the data (RBAC: assignment, set, link, rule; ABAC: policy; core: scope). */
export abstract class AuthzWriteHandler {
  abstract readonly kinds: readonly AuthzCommand['kind'][];
  abstract validate(c: AuthzCommand, ctx: AdminContext): Promise<void>; // throws AuthzAdminFailure(code)
  /** What the actor must hold. Id-only commands (revoke, tags, expiry) carry no scope, so the handler may load the row to find it. */
  abstract permission(c: AuthzCommand, ctx: AdminContext): { permission: Permission; resource: ResourceRef } | Promise<{ permission: Permission; resource: ResourceRef }>;
  abstract apply(c: AuthzCommand, ctx: AdminContext, tx: AuthzTx): Promise<{ id?: string; token?: string; affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }>;
}

/** DefaultAdminGuard in @spinajs/authz-rbac implements it; was RoleGuard. AuthzAdmin runs the one named in authz.admin.guard.service. */
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
