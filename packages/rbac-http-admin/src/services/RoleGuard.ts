import { Injectable, DI } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { Forbidden, InvalidArgument } from '@spinajs/exceptions';
import { AccessControl, User, _combineGrants, _unwindGrants } from '@spinajs/rbac';
import _ from 'lodash';

import { AccountDisableAction, IRoleGuardConfig, RoleGuard } from '../interfaces.js';

/** A resolved grant map: resource -> action -> attribute list. */
type GrantMap = { [resource: string]: { [action: string]: string[] } };

/**
 * The shipped {@link RoleGuard}.
 *
 * Every check reads its switch from `rbac.admin.roleGuard`, so an application
 * turns one off in configuration instead of replacing the whole service — and
 * an application that needs a different rule entirely registers its own class
 * under {@link RoleGuard} and names it in `rbac.admin.roleGuard.service`.
 */
@Injectable(RoleGuard)
export class DefaultRoleGuard extends RoleGuard {
  @Logger('rbac-admin')
  protected Log: Log;

  @Config('rbac.admin.roleGuard')
  protected Options: IRoleGuardConfig;

  @Config('rbac.systemRole', { defaultValue: 'system' })
  protected SystemRole: string;

  /**
   * Declared roles, which is NOT the same set as the roles accesscontrol knows
   * about: a role may be declared for assignment and carry no grants yet.
   */
  @Config('rbac.roles', { defaultValue: [] as Array<{ Name: string }> })
  protected DeclaredRoles: Array<{ Name: string }>;

  /**
   * Resolved late, never cached in a field: the container entry is replaced
   * whenever the rbac bootstrapper runs ( every test case does ), and a guard
   * holding the stale instance would answer from grants nobody configured.
   */
  protected get AC(): AccessControl {
    return DI.get<AccessControl>('AccessControl')!;
  }

  public async assertCanAssignRoles(actor: User, target: User | null, roles: string[]): Promise<void> {
    const wanted = _.uniq((roles ?? []).map((r) => String(r ?? '').trim()).filter((r) => r.length > 0));

    if (wanted.length === 0) {
      return;
    }

    this.assertActor(actor);

    for (const role of wanted) {
      this.assertKnownRole(role);
      this.assertNotSystemRole(role, 'assigned');

      if (this.Options?.preventEscalation !== false && !this.covers(this.grantsOf(actor), this.grantsOfRole(role))) {
        throw new Forbidden(`Role '${role}' grants more than the caller holds and cannot be assigned`);
      }
    }

    // The guard passed — the assignment itself is the caller's next step. Logged
    // with the actor because the rbac events carry the TARGET only, so this line
    // is the one record of who handed out which role.
    this.Log.info(`Role assignment allowed`, {
      Actor: actor?.Uuid,
      Target: target?.Uuid ?? null,
      Roles: wanted,
    });
  }

  public async assertCanRevokeRole(actor: User, target: User, role: string): Promise<void> {
    const wanted = String(role ?? '').trim();

    if (wanted.length === 0) {
      throw new InvalidArgument('role cannot be empty');
    }

    this.assertActor(actor);
    this.assertKnownRole(wanted);
    this.assertNotSystemRole(wanted, 'revoked');

    if (!this.isPrivileged(wanted)) {
      return;
    }

    // Taking a privileged role off YOUR OWN account through the admin API is
    // almost always a mistake and is never recoverable through the same API —
    // the request that would put the role back needs the role.
    if (this.Options?.preventSelfLockout !== false && this.isSelf(actor, target)) {
      throw new Forbidden(`Cannot revoke your own '${wanted}' role`);
    }

    if (this.Options?.preventLastPrivilegedRemoval !== false && target?.Role?.includes(wanted)) {
      await this.assertNotLastHolder(wanted, `revoke '${wanted}'`);
    }
  }

  public async assertCanDisableAccount(actor: User, target: User, action: AccountDisableAction): Promise<void> {
    this.assertActor(actor);

    if (this.Options?.preventSelfLockout !== false && this.isSelf(actor, target)) {
      throw new Forbidden(`Cannot ${action} your own account`);
    }

    if (this.Options?.preventLastPrivilegedRemoval === false) {
      return;
    }

    for (const role of target?.Role ?? []) {
      if (this.isPrivileged(role)) {
        await this.assertNotLastHolder(role, action);
      }
    }
  }

  public assignableRoles(actor: User): string[] {
    const all = _.uniq([...(this.DeclaredRoles ?? []).map((r) => r?.Name).filter(Boolean), ...this.rolesWithGrants()]);

    const withoutSystem = this.Options?.protectSystemRole === false ? all : all.filter((r) => r !== this.SystemRole);

    if (this.Options?.preventEscalation === false) {
      return withoutSystem;
    }

    const actorGrants = this.grantsOf(actor);
    return withoutSystem.filter((r) => this.covers(actorGrants, this.grantsOfRole(r)));
  }

  /**
   * A missing actor is a programming error on a route that must be behind
   * `AuthorizedPolicy` — refused rather than waved through, because every
   * escalation check below is meaningless without one.
   */
  protected assertActor(actor: User): void {
    if (!actor) {
      throw new Forbidden('Role changes require an authenticated caller');
    }
  }

  protected assertKnownRole(role: string): void {
    if (this.Options?.requireKnownRole === false) {
      return;
    }

    const known = _.uniq([...(this.DeclaredRoles ?? []).map((r) => r?.Name).filter(Boolean), ...this.rolesWithGrants(), this.SystemRole]);

    if (!known.includes(role)) {
      throw new InvalidArgument(`Role '${role}' is not declared in rbac configuration`);
    }
  }

  protected assertNotSystemRole(role: string, verb: string): void {
    if (this.Options?.protectSystemRole !== false && role === this.SystemRole) {
      throw new Forbidden(`The system role cannot be ${verb} through the API`);
    }
  }

  protected isSelf(actor: User, target: User): boolean {
    if (!actor || !target) {
      return false;
    }

    // Uuid first: an actor resolved from a session and a target loaded by route
    // parameter are two different model instances of the same row.
    return (actor.Uuid && actor.Uuid === target.Uuid) || (!!actor.Id && actor.Id === target.Id);
  }

  /**
   * Throws when `target` is the last account that can still act with `role`.
   *
   * Counts accounts that could actually log in — inactive and soft-deleted rows
   * are not a way back into the installation.
   */
  protected async assertNotLastHolder(role: string, action: string): Promise<void> {
    const holders = await this.countActiveHolders(role);

    // The target itself is one of them ( it is active and holds the role ), so
    // one holder means the operation empties the role.
    if (holders <= 1) {
      throw new Forbidden(`Cannot ${action}: it would leave no active account holding '${role}'`);
    }
  }

  /**
   * Active accounts holding `role`.
   *
   * Counted in the database. This used to narrow with LIKE and finish the job in
   * memory, because `withRole` compiled to `FIND_IN_SET` — MySQL only — and threw
   * a driver error on SQLite, turning "is this the last administrator" into a 500
   * on every deployment that is not MySQL. Set membership is a per-dialect
   * statement now, so the scope answers everywhere and the workaround is gone.
   */
  protected async countActiveHolders(role: string): Promise<number> {
    // base User on purpose: the last-holder check counts ALL holders, not the
    // callers's visible subset
    return User.query().isActiveUser().withRole([role]).selectCount();
  }

  protected isPrivileged(role: string): boolean {
    const resource = this.Options?.privilegedResource ?? 'users';
    const action = this.Options?.privilegedAction ?? 'update:any';

    return Boolean(this.grantsOfRole(role)?.[resource]?.[action]);
  }

  protected rolesWithGrants(): string[] {
    try {
      return this.AC?.getRoles() ?? [];
    } catch {
      // accesscontrol throws when no grants were ever set
      return [];
    }
  }

  protected allGrants(): GrantMap {
    try {
      return (this.AC?.getGrants() ?? {}) as unknown as GrantMap;
    } catch {
      return {} as GrantMap;
    }
  }

  /** Grants of one role, with its `$extend` chain resolved. */
  protected grantsOfRole(role: string): GrantMap {
    return _unwindGrants(role, this.allGrants() as any) as GrantMap;
  }

  /**
   * The caller's ceiling: the union of every role they hold.
   *
   * Deliberately the union and not the session's active role — an administrator
   * who can switch to a stronger role could otherwise be blocked from an
   * operation they can perform by switching first, which teaches people to
   * switch rather than to stay in the weaker role.
   */
  protected grantsOf(actor: User): GrantMap {
    const grants = this.allGrants();
    return _combineGrants(...(actor?.Role ?? []).map((r) => _unwindGrants(r, grants as any))) as GrantMap;
  }

  /**
   * True when `holder` permits everything `wanted` does.
   *
   * Attributes are compared as sets, with `*` covering anything. Negated
   * attributes ( `!Password` ) are treated as ordinary members: a holder that
   * lists the same negation still covers, one that does not is reported as not
   * covering. That errs towards refusing an assignment, which is the safe
   * direction for a guard.
   *
   * `:any` covers the matching `:own`, exactly as accesscontrol resolves them at
   * enforcement time. Without that an administrator holding `read:any` on users
   * would be told they cannot hand out a role holding `read:own` — a role
   * strictly weaker than their own.
   */
  protected covers(holder: GrantMap, wanted: GrantMap): boolean {
    for (const [resource, actions] of Object.entries(wanted ?? {})) {
      const held = holder?.[resource];

      if (!held) {
        return false;
      }

      for (const [action, attributes] of Object.entries(actions ?? {})) {
        const heldAttributes = held[action] ?? (action.endsWith(':own') ? held[action.replace(/:own$/, ':any')] : undefined);

        if (!heldAttributes) {
          return false;
        }

        if (heldAttributes.includes('*')) {
          continue;
        }

        if ((attributes ?? []).some((a) => !heldAttributes.includes(a))) {
          return false;
        }
      }
    }

    return true;
  }
}
