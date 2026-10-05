import { InitiatorPrincipalFactory, StampedInitiatorPrincipalFactory, reviveCeiling } from '@spinajs/authz-queue';
import type { Initiator } from '@spinajs/authz-queue';
import { UNATTENDED } from '@spinajs/authz';
import type { Ceiling, Principal } from '@spinajs/authz';
import { PrincipalFactory } from '@spinajs/authn/contracts';
import { DI, Injectable } from '@spinajs/di';

import { userModel } from '../model-token.js';
import type { User } from '../models/User.js';
import { UserPrincipalFactory } from '../principal/user-principal-factory.js';
import { runAsSystem } from '../system.js';

/** The `source` of a principal a job runs as. */
export const QUEUE_PRINCIPAL_SOURCE = 'queue';

/**
 * Rebuilds the principal of a job that runs as its initiator (authz-queue), reading the user again: a user stamp
 * becomes the principal {@link UserPrincipalFactory} builds for the stored record (provider attributes included),
 * with the stamped ceiling and source {@link QUEUE_PRINCIPAL_SOURCE}. A user that is unknown, soft deleted, inactive
 * or banned by now, or a malformed stamp, gives `UNATTENDED`; a failing store or provider throws, so the job is
 * retried.
 *
 * An agent stamp also gives `UNATTENDED`: the stamp cannot name the owner, so the owner's state could not be checked
 * and the agent would act on its own grants. authz-queue never stamps a delegated principal, so such a stamp is not
 * one of its own. Every other type is the stamped factory's.
 */
@Injectable(InitiatorPrincipalFactory)
export class UserInitiatorPrincipalFactory extends InitiatorPrincipalFactory {
  // Its one-time warning says users are not reloaded, which is untrue here.
  protected readonly stamped: InitiatorPrincipalFactory = Object.assign(new StampedInitiatorPrincipalFactory(), { warned: true } as object);

  public async principalOf(initiator: Initiator): Promise<Principal> {
    const stamp = (initiator !== null && typeof initiator === 'object' ? initiator : {}) as { type?: unknown; id?: unknown; ceiling?: unknown };
    if (stamp.type === 'agent') {
      return UNATTENDED;
    }
    if (stamp.type !== 'user') {
      return this.stamped.principalOf(initiator);
    }

    const { id, ceiling } = stamp;
    if (typeof id !== 'string' || id === '') {
      return UNATTENDED;
    }
    let revived: Ceiling | undefined;
    if (ceiling !== undefined && ceiling !== null) {
      revived = reviveCeiling(ceiling);
      if (revived === undefined) {
        return UNATTENDED;
      }
    }

    // The application's user model may be an @AccessResource; the job's own principal is not known yet.
    const user = (await runAsSystem('queue-initiator', () => userModel().query().whereUuid(id).populate('Metadata').first())) as User | undefined;
    if (!user || user.DeletedAt || !user.IsActive || user.IsBanned) {
      return UNATTENDED;
    }

    return (await this.users()).principalOf(user, { source: QUEUE_PRINCIPAL_SOURCE, ...(revived ? { ceiling: revived } : {}) });
  }

  /** The application's PrincipalFactory when it is a UserPrincipalFactory (a subclass, say), else users' own. */
  protected async users(): Promise<UserPrincipalFactory> {
    const registered = await DI.resolve(PrincipalFactory);
    return registered instanceof UserPrincipalFactory ? registered : ((await DI.resolve(UserPrincipalFactory)) as UserPrincipalFactory);
  }
}
