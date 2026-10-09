import { AuthzService, GLOBAL, SYSTEM, principalKey } from '@spinajs/authz';
import type { Permission, Principal, PrincipalRef } from '@spinajs/authz';
import { AccountStatusSource, AssignmentStore, guardSwitches } from '@spinajs/authz-rbac';
import { Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { User, UserPrincipalFactory, userModel } from '@spinajs/users';

import { configuredRoleNames } from './user-roles.js';

/** A route that takes an account out of service. */
export type AccountDisableAction = 'delete' | 'deactivate' | 'ban';

const LOOKUP_CHUNK = 100;

/**
 * Keeps an account in service holding `authz.admin.guard.privilegedPermission`. The lifecycle routes are not
 * AuthzAdmin commands, so AuthzAdmin's guard never sees them.
 */
export abstract class AccountGuard {
  abstract assertCanDisable(actor: Principal, target: User, action: AccountDisableAction): Promise<void>;

  /** `kept`: the target's GLOBAL roles that a role replacement leaves in place. */
  abstract assertCanDemote(actor: Principal, target: User, kept: readonly string[]): Promise<void>;
}

/**
 * Reads `authz.admin.guard` (the switches AuthzAdmin's guard reads) on every call. Self lockout: the actor
 * may not disable its own account, nor take its own privilege. Last holder: an account holding
 * `privilegedPermission` unconditionally loses it only while another user in service holds it. A witness is in
 * service when the registered AccountStatusSource answers exactly `true` for it (users' source also refuses an
 * expired password and a pending invite) and its row is active, unbanned and undeleted. A source that is
 * missing, throws or answers anything else counts no witness and ends the search. Witnesses are searched role by
 * role among the GLOBAL user holders of each configured role, 100 holders per source call, and only the first
 * in-service holder of a role is tried; a holder reachable only through a subject set, or one who is not the
 * first in-service holder of any role, is not found, so the check fails closed.
 */
@Injectable(AccountGuard)
export class DefaultAccountGuard extends AccountGuard {
  @Config('authz.admin.guard')
  protected Guard: unknown;

  @Logger('users-http')
  protected Log: Log;

  private warnedNoStatusSource = false;

  public async assertCanDisable(actor: Principal, target: User, action: AccountDisableAction): Promise<void> {
    const cfg = guardSwitches(this.Guard, 'users-http AccountGuard');

    if (cfg.preventSelfLockout && isSelf(actor, target)) {
      throw new Forbidden(`Cannot ${action} your own account`);
    }

    if (!cfg.preventLastPrivilegedRemoval || cfg.privilegedPermission === undefined) {
      return;
    }

    const current = await this.reload(target);
    if ((await this.privilegedNow(current, cfg.privilegedPermission)) && !(await this.hasWitness(current, cfg.privilegedPermission))) {
      throw new Forbidden(`Cannot ${action} this account: it would leave no account in service holding '${cfg.privilegedPermission}'`);
    }
  }

  public async assertCanDemote(actor: Principal, target: User, kept: readonly string[]): Promise<void> {
    const cfg = guardSwitches(this.Guard, 'users-http AccountGuard');
    const permission = cfg.privilegedPermission;

    if (permission === undefined || (!cfg.preventSelfLockout && !cfg.preventLastPrivilegedRemoval)) {
      return;
    }

    const current = await this.reload(target);
    if (!(await this.privilegedNow(current, permission))) {
      return;
    }

    // A ceiling role the account does not hold gives nothing, so roles the batch adds are not counted.
    if (kept.length > 0 && (await this.privileged(await this.principalOf(current, kept), permission))) {
      return;
    }

    if (cfg.preventSelfLockout && isSelf(actor, current)) {
      throw new Forbidden(`Cannot remove '${permission}' from your own account`);
    }

    if (cfg.preventLastPrivilegedRemoval && !(await this.hasWitness(current, permission))) {
      throw new Forbidden(`Cannot change the roles of this account: it would leave no account in service holding '${permission}'`);
    }
  }

  /**
   * An account already out of service holds nothing anyone relies on. Read from the row, not from the
   * AccountStatusSource: a password reset or an accepted invite brings an account back, and a failing source must
   * not make the last administrator look out of service.
   */
  protected async privilegedNow(user: User, permission: Permission): Promise<boolean> {
    return usable(user) && (await this.privileged(await this.principalOf(user), permission));
  }

  protected async hasWitness(target: User, permission: Permission): Promise<boolean> {
    const store = (await DI.resolve(AssignmentStore)) as AssignmentStore;
    const now = new Date();
    // An account holding several roles is asked about once.
    const answered = new Map<string, boolean>();
    const probed = new Set<string>([target.Uuid]);
    for (const role of await configuredRoleNames()) {
      const ids = new Set<string>();
      for (const holder of await store.holders(role, GLOBAL, now)) {
        if (!('set' in holder) && holder.type === 'user' && !probed.has(holder.id) && answered.get(holder.id) !== false) {
          ids.add(holder.id);
        }
      }

      const witness = await this.firstInService([...ids], answered);
      if (witness === 'unknown') {
        return false;
      }
      if (!witness) {
        continue;
      }

      probed.add(witness.Uuid);
      if (await this.privileged(await this.principalOf(witness), permission)) {
        return true;
      }
    }

    return false;
  }

  /**
   * The first usable row among `uuids` that the AccountStatusSource puts in service, one source call and one row
   * query per slice, stopping at the first slice that has one. `'unknown'` when the source gives no usable answer.
   */
  protected async firstInService(uuids: readonly string[], answered: Map<string, boolean>): Promise<User | undefined | 'unknown'> {
    for (let i = 0; i < uuids.length; i += LOOKUP_CHUNK) {
      const slice = uuids.slice(i, i + LOOKUP_CHUNK);
      const unasked = slice.filter((id) => !answered.has(id));
      if (unasked.length > 0) {
        const found = await this.inService(unasked);
        if (!found) {
          return 'unknown';
        }
        for (const id of unasked) {
          answered.set(id, found.has(id));
        }
      }

      const ids = slice.filter((id) => answered.get(id) === true);
      if (ids.length === 0) {
        continue;
      }
      const rows = await this.asSystem(async () => (await userModel().query().whereIn('Uuid', ids).populate('Metadata')) as User[]);
      const row = rows.find(usable);
      if (row) {
        return row;
      }
    }

    return undefined;
  }

  /** The uuids the AccountStatusSource answers exactly `true` for, asked in one call; undefined when it is missing or fails. */
  protected async inService(uuids: readonly string[]): Promise<ReadonlySet<string> | undefined> {
    // A DI.unregister leaves the key with an empty list, so the list is checked, not the key.
    const registered = DI.getRegisteredTypes(AccountStatusSource);
    if (!registered || registered.length === 0) {
      if (!this.warnedNoStatusSource) {
        this.warnedNoStatusSource = true;
        this.Log.warn('users-http AccountGuard: no AccountStatusSource is registered, so no account counts as a remaining holder of the privileged permission');
      }
      return undefined;
    }

    const refs: PrincipalRef[] = uuids.map((id) => ({ type: 'user', id }));
    try {
      const source = (await DI.resolve(AccountStatusSource)) as AccountStatusSource;
      const answers: unknown = await source.inService(refs);
      if (!(answers instanceof Map)) {
        throw new TypeError('the answer is not a Map');
      }
      return new Set(refs.filter((ref) => answers.get(principalKey(ref)) === true).map((ref) => ref.id));
    } catch (e) {
      this.Log.warn(`users-http AccountGuard: the AccountStatusSource failed, so no account counts as a remaining holder of the privileged permission: ${e instanceof Error ? `${e.name}: ${e.message}` : typeof e}`);
      return undefined;
    }
  }

  protected async reload(record: User): Promise<User> {
    // The ban lives in the metadata; a record read without it would pass as not banned.
    if (record.Metadata?.Populated === true) {
      return record;
    }

    return this.asSystem(async () => (await userModel().query().withDeleted().where('Uuid', record.Uuid).populate('Metadata').firstOrFail()) as User);
  }

  /** `permission` at GLOBAL with no residual: a conditional allow does not make an account privileged. */
  protected async privileged(principal: Principal, permission: Permission): Promise<boolean> {
    const authz = (await DI.resolve(AuthzService)) as AuthzService;
    const decision = await authz.check({ principal, permission, resource: GLOBAL });

    return decision.allowed && decision.residual.op === 'true';
  }

  protected async principalOf(user: User, roles?: readonly string[]): Promise<Principal> {
    const factory = (await DI.resolve(UserPrincipalFactory)) as UserPrincipalFactory;
    return factory.principalOf(user, roles ? { ceiling: { roles: [...roles] } } : undefined);
  }

  /** User model reads must not be narrowed by the caller's row scoping. */
  protected async asSystem<T>(work: () => Promise<T>): Promise<T> {
    const authz = (await DI.resolve(AuthzService)) as AuthzService;
    return authz.runAs(SYSTEM, 'users-http-account-guard', work);
  }
}

function isSelf(actor: Principal, target: User): boolean {
  return actor.type === 'user' && actor.id === target.Uuid;
}

function usable(user: User): boolean {
  return !user.DeletedAt && user.IsActive === true && !user.IsBanned;
}
