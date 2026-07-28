import { User } from '@spinajs/rbac';

/**
 * What an administrator is allowed to do to roles and to accounts, read from
 * `rbac.admin.roleGuard`.
 *
 * Every check is switchable because the right answer is deployment-specific: a
 * single-tenant back office with two trusted operators wants none of this, a
 * multi-tenant one wants all of it. The shipped defaults are the strict end —
 * an application that needs less has to say so explicitly.
 */
export interface IRoleGuardConfig {
  /** Registered name of the {@link RoleGuard} implementation to use. */
  service: string;

  /** Reject role names that are not declared in `rbac.grants` / `rbac.roles`. */
  requireKnownRole: boolean;

  /** Refuse to grant or revoke `rbac.systemRole` over HTTP, whoever is asking. */
  protectSystemRole: boolean;

  /**
   * Refuse to grant a role whose resolved grants are not a subset of the
   * caller's own. Without this, `updateAny` on `users` is a path to every other
   * permission in the system — an administrator simply grants themselves more.
   */
  preventEscalation: boolean;

  /**
   * Refuse operations that would strip the CALLER of their own privileged role
   * or of their own account ( self-deactivation, self-deletion, self-ban ).
   */
  preventSelfLockout: boolean;

  /**
   * Refuse operations that would leave zero usable accounts holding a
   * privileged role — the "locked out of your own installation" case.
   */
  preventLastPrivilegedRemoval: boolean;

  /**
   * Resource + action that make a role "privileged" for the two guards above.
   * Action is written in accesscontrol grant notation, as it appears in
   * `rbac.grants` ( `update:any`, not `updateAny` ).
   */
  privilegedResource: string;
  privilegedAction: string;
}

/**
 * Role and account-state guard for the admin API.
 *
 * The checks live here rather than in the controllers because the same rule has
 * to hold on every path that can change what an account may do: granting a role,
 * revoking one, rewriting the whole role list through `PATCH /users/:uuid`, and
 * taking an account out of service. A rule implemented per-controller is a rule
 * that will be missing from the next controller.
 *
 * All methods THROW on refusal ( `Forbidden` / `InvalidArgument`, which the http
 * error map turns into 403 / 400 ) and return normally when the operation is
 * allowed.
 */
export abstract class RoleGuard {
  /**
   * May `actor` put `roles` on `target`?
   *
   * @param actor - the authenticated administrator making the request
   * @param target - the account being changed, or null when it does not exist yet ( creation )
   * @param roles - roles that would be assigned
   */
  public abstract assertCanAssignRoles(actor: User, target: User | null, roles: string[]): Promise<void>;

  /**
   * May `actor` take `role` away from `target`?
   */
  public abstract assertCanRevokeRole(actor: User, target: User, role: string): Promise<void>;

  /**
   * May `actor` take `target` out of service ( deactivate / delete / ban )?
   */
  public abstract assertCanDisableAccount(actor: User, target: User, action: AccountDisableAction): Promise<void>;

  /**
   * Roles `actor` is allowed to hand out, for populating an admin UI. Returning
   * this rather than the full role list keeps the UI from offering an operation
   * the guard will refuse.
   */
  public abstract assignableRoles(actor: User): string[];
}

/** Operations that end an account's ability to act. */
export type AccountDisableAction = 'deactivate' | 'delete' | 'ban';
