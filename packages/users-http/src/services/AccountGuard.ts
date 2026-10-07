import { AuthzService, GLOBAL, SYSTEM } from '@spinajs/authz';
import type { Permission, Principal } from '@spinajs/authz';
import { AssignmentStore, guardSwitches } from '@spinajs/authz-rbac';
import { Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { User, UserPrincipalFactory, userModel } from '@spinajs/users';

import { configuredRoleNames } from './user-roles.js';

/** A route that takes an account out of service. */
export type AccountDisableAction = 'delete' | 'deactivate' | 'ban' | 'expire-password';

const VERB: Readonly<Record<AccountDisableAction, string>> = {
  delete: 'delete',
  deactivate: 'deactivate',
  ban: 'ban',
  'expire-password': 'expire the password of',
};

const LOOKUP_CHUNK = 100;

/**
 * Keeps an active account holding `authz.admin.guard.privilegedPermission`. The lifecycle routes are not
 * AuthzAdmin commands, so AuthzAdmin's guard never sees them; and on a role replacement its last-holder rule
 * counts every GLOBAL holder, deactivated, banned and deleted accounts included.
 */
export abstract class AccountGuard {
  abstract assertCanDisable(actor: Principal, target: User, action: AccountDisableAction): Promise<void>;

  /** `kept`: the target's GLOBAL roles that a role replacement leaves in place. */
  abstract assertCanDemote(actor: Principal, target: User, kept: readonly string[]): Promise<void>;
}

/**
 * Reads `authz.admin.guard` (the switches AuthzAdmin's guard reads) on every call. Self lockout: the actor
 * may not disable its own account, nor take its own privilege. Last holder: an account holding
 * `privilegedPermission` unconditionally loses it only while another active, unbanned, undeleted user holds
 * it. Witnesses are searched once per configured role, among the GLOBAL user holders of that role; a holder
 * reachable only through a subject set, or one who is not the first usable holder of any role, is not found,
 * so the check fails closed.
 */
@Injectable(AccountGuard)
export class DefaultAccountGuard extends AccountGuard {
  @Config('authz.admin.guard')
  protected Guard: unknown;

  public async assertCanDisable(actor: Principal, target: User, action: AccountDisableAction): Promise<void> {
    const cfg = guardSwitches(this.Guard, 'users-http AccountGuard');
    const verb = VERB[action];

    if (cfg.preventSelfLockout && isSelf(actor, target)) {
      throw new Forbidden(`Cannot ${verb} your own account`);
    }

    if (!cfg.preventLastPrivilegedRemoval || cfg.privilegedPermission === undefined) {
      return;
    }

    const current = await this.reload(target);
    if ((await this.privilegedNow(current, cfg.privilegedPermission)) && !(await this.hasWitness(current, cfg.privilegedPermission))) {
      throw new Forbidden(`Cannot ${verb} this account: it would leave no active account holding '${cfg.privilegedPermission}'`);
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
      throw new Forbidden(`Cannot change the roles of this account: it would leave no active account holding '${permission}'`);
    }
  }

  /** An account already out of service holds nothing anyone relies on. */
  protected async privilegedNow(user: User, permission: Permission): Promise<boolean> {
    return usable(user) && (await this.privileged(await this.principalOf(user), permission));
  }

  protected async hasWitness(target: User, permission: Permission): Promise<boolean> {
    const store = (await DI.resolve(AssignmentStore)) as AssignmentStore;
    const now = new Date();
    const probed = new Set<string>([target.Uuid]);

    for (const role of await configuredRoleNames()) {
      const ids = new Set<string>();
      for (const holder of await store.holders(role, GLOBAL, now)) {
        if (!('set' in holder) && holder.type === 'user' && !probed.has(holder.id)) {
          ids.add(holder.id);
        }
      }

      const witness = await this.firstUsable([...ids]);
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

  protected async firstUsable(uuids: readonly string[]): Promise<User | undefined> {
    for (let i = 0; i < uuids.length; i += LOOKUP_CHUNK) {
      const chunk = uuids.slice(i, i + LOOKUP_CHUNK);
      const rows = await this.asSystem(async () => (await userModel().query().whereIn('Uuid', chunk).populate('Metadata')) as User[]);
      const found = rows.find(usable);
      if (found) {
        return found;
      }
    }

    return undefined;
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
