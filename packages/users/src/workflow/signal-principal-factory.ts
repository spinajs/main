import { SignalPrincipalFactory, StampedSignalPrincipalFactory } from '@spinajs/authz-workflow';
import { UNATTENDED } from '@spinajs/authz';
import type { Principal, PrincipalRef } from '@spinajs/authz';
import { PrincipalFactory } from '@spinajs/authn/contracts';
import { Autoinject, Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';

import { userModel } from '../model-token.js';
import type { User } from '../models/User.js';
import { UserPrincipalFactory } from '../principal/user-principal-factory.js';
import { runAsSystem } from '../system.js';
import { isUserUuid } from '../user-uuid.js';

/** The `source` of a principal a permissioned wait checks a signal as. */
export const WORKFLOW_PRINCIPAL_SOURCE = 'workflow';

function isPrincipalRef(ref: unknown): ref is PrincipalRef {
  return ref !== null && typeof ref === 'object' && !Array.isArray(ref) && 'type' in ref && 'id' in ref && typeof ref.type === 'string' && ref.type !== '' && typeof ref.id === 'string' && ref.id !== '';
}

/**
 * Rebuilds the principal a permissioned `waitForEvent` checks a signal as (authz-workflow), reading the user again:
 * a user stamp becomes the principal {@link UserPrincipalFactory} builds for the stored record (provider attributes
 * included), with source {@link WORKFLOW_PRINCIPAL_SOURCE}. A user that is unknown, soft deleted, inactive or banned
 * by now gives `UNATTENDED`; a failing store or provider throws, so the wait is asked again.
 *
 * An agent stamp also gives `UNATTENDED`: it cannot name the owner to reload, and trusting it would let the agent
 * act on its own grants. Every other type is the stamped factory's.
 */
@Injectable(SignalPrincipalFactory)
export class UserSignalPrincipalFactory extends SignalPrincipalFactory {
  // Its one-time warning says users are not reloaded, which is untrue here.
  protected readonly stamped: SignalPrincipalFactory = new StampedSignalPrincipalFactory({ warn: false });

  @Autoinject(PrincipalFactory)
  protected Principals: PrincipalFactory;

  @Autoinject(UserPrincipalFactory)
  protected Users: UserPrincipalFactory;

  @Logger('users')
  protected Log: Log;

  public async principalOf(ref: PrincipalRef): Promise<Principal> {
    // authz-workflow passes a parsed stamp, but this is a public service: a throw here would keep the signal pending forever
    if (!isPrincipalRef(ref)) {
      this.malformed(ref);
      return UNATTENDED;
    }
    if (ref.type === 'agent') {
      return UNATTENDED;
    }
    if (ref.type !== 'user') {
      return this.stamped.principalOf(ref);
    }
    if (!isUserUuid(ref.id)) {
      return UNATTENDED;
    }

    // The application's user model may be an @AccessResource; the principal of the signal is not known yet.
    const user = (await runAsSystem('workflow-signal', () => userModel().query().whereUuid(ref.id).populate('Metadata').first())) as User | undefined;
    if (!user || user.DeletedAt || !user.IsActive || user.IsBanned) {
      return UNATTENDED;
    }

    return (await this.users()).principalOf(user, { source: WORKFLOW_PRINCIPAL_SOURCE });
  }

  /** The application's PrincipalFactory when it is a UserPrincipalFactory (a subclass, say), else users' own. */
  protected async users(): Promise<UserPrincipalFactory> {
    return this.Principals instanceof UserPrincipalFactory ? this.Principals : this.Users;
  }

  protected malformed(ref: unknown): void {
    const kind = ref === null ? 'null' : Array.isArray(ref) ? 'array' : typeof ref;
    this.Log.warn({ kind }, 'A workflow signal stamp (${kind}) is not { type, id } with non-empty strings; the signal is checked as UNATTENDED');
  }
}
