import { AuthzService, GLOBAL } from '@spinajs/authz';
import type { Permission, Principal } from '@spinajs/authz';
import { AssignmentStore, readGuardConfig } from '@spinajs/authz-rbac';
import { Configuration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { User, UserPrincipalFactory, userModel } from '@spinajs/users';

import { globalRolesOf } from './user-roles.js';

/** A route that takes an account out of service. */
export type AccountDisableAction = 'delete' | 'deactivate' | 'ban' | 'expire-password';

const VERB: Readonly<Record<AccountDisableAction, string>> = {
  delete: 'delete',
  deactivate: 'deactivate',
  ban: 'ban',
  'expire-password': 'expire the password of',
};

/**
 * Decides whether `actor` may take `target` out of service. These routes are not AuthzAdmin commands, so
 * AuthzAdmin's guard never sees them; this applies its self-lockout and last-holder rules to them.
 */
export abstract class AccountGuard {
  abstract assertCanDisable(actor: Principal, target: User, action: AccountDisableAction): Promise<void>;
}

/**
 * Reads `authz.admin.guard` (the switches AuthzAdmin's guard reads) on every call. Self lockout: the actor
 * may not disable its own account. Last holder: an account holding `privilegedPermission` unconditionally
 * goes only while another active, unbanned, undeleted user holds it through a GLOBAL assignment of a role
 * that alone makes the target privileged; a holder reachable only through another role or a subject set is
 * not found, so the check fails closed.
 */
@Injectable(AccountGuard)
export class DefaultAccountGuard extends AccountGuard {
  public async assertCanDisable(actor: Principal, target: User, action: AccountDisableAction): Promise<void> {
    const configuration = (await DI.resolve(Configuration)) as Configuration;
    const cfg = readGuardConfig(configuration.get(['authz', 'admin', 'guard']), 'users-http AccountGuard');
    const verb = VERB[action];

    if (cfg.preventSelfLockout && actor.type === 'user' && actor.id === target.Uuid) {
      throw new Forbidden(`Cannot ${verb} your own account`);
    }

    if (!cfg.preventLastPrivilegedRemoval || cfg.privilegedPermission === undefined) {
      return;
    }

    if (await this.leavesNoHolder(target, cfg.privilegedPermission)) {
      throw new Forbidden(`Cannot ${verb} this account: it would leave no active account holding '${cfg.privilegedPermission}'`);
    }
  }

  protected async leavesNoHolder(record: User, permission: Permission): Promise<boolean> {
    // The ban lives in the metadata; a record read without it would pass as not banned.
    const target = record.Metadata?.Populated === true ? record : await userModel().query().withDeleted().where('Uuid', record.Uuid).populate('Metadata').firstOrFail();

    // An account already out of service holds nothing anyone relies on.
    if (!usable(target) || !(await this.privileged(await this.principalOf(target), permission))) {
      return false;
    }

    const store = (await DI.resolve(AssignmentStore)) as AssignmentStore;
    const now = new Date();

    for (const role of await globalRolesOf(target.Uuid)) {
      if (!(await this.privileged(await this.principalOf(target, [role]), permission))) {
        continue;
      }

      for (const holder of await store.holders(role, GLOBAL, now)) {
        if ('set' in holder || holder.type !== 'user' || holder.id === target.Uuid) {
          continue;
        }

        const witness = await userModel().query().where('Uuid', holder.id).populate('Metadata').first();
        if (witness && usable(witness) && (await this.privileged(await this.principalOf(witness), permission))) {
          return false;
        }
      }
    }

    return true;
  }

  /** `permission` at GLOBAL with no residual: a conditional allow does not make an account privileged. */
  protected async privileged(principal: Principal, permission: Permission): Promise<boolean> {
    const authz = (await DI.resolve(AuthzService)) as AuthzService;
    const decision = await authz.check({ principal, permission, resource: GLOBAL });

    return decision.allowed && decision.residual.op === 'true';
  }

  protected async principalOf(user: User, roles?: string[]): Promise<Principal> {
    const factory = (await DI.resolve(UserPrincipalFactory)) as UserPrincipalFactory;
    return factory.principalOf(user, roles ? { ceiling: { roles } } : undefined);
  }
}

function usable(user: User): boolean {
  return !user.DeletedAt && user.IsActive === true && !user.IsBanned;
}
