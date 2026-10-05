import { Injectable } from '@spinajs/di';
import { ev } from '@spinajs/queue';
import { AuthnEventSink } from '@spinajs/authn/contracts';
import type { AuthnEvent } from '@spinajs/authn/contracts';

import { InvalidCredentials } from '../exceptions.js';
import { UserImpersonationEnded } from '../events/UserImpersonationEnded.js';
import { UserImpersonationStarted } from '../events/UserImpersonationStarted.js';
import { UserLogged } from '../events/UserLogged.js';
import { UserLoginFailed } from '../events/UserLoginFailed.js';
import { UserPasswordChangeRequest } from '../events/UserPasswordChangeRequest.js';
import { UserPasswordChanged } from '../events/UserPasswordChanged.js';
import { UserPasswordExpired } from '../events/UserPasswordExpired.js';
import { User } from '../models/User.js';

type Ref = { readonly type: string; readonly id: string };

/**
 * Re-emits, through the queue, the 2.x user events that authn now decides: `UserLogged`, `UserLoginFailed`,
 * `UserPasswordChanged`, `UserPasswordExpired`, `UserPasswordChangeRequest` (also for an invite, as 2.x did),
 * `UserImpersonationStarted` and `UserImpersonationEnded`. Each carries the `User` row, deleted ones included;
 * an event about an identity that is not a stored user is not re-emitted. The 2FA events live in authn-totp,
 * which depends on users. Errors propagate to the publisher, which logs their class.
 */
@Injectable(AuthnEventSink)
export class QueueAuthnEventSink extends AuthnEventSink {
  public async publish(e: AuthnEvent): Promise<void> {
    const success = e.outcome === 'success';

    switch (e.type) {
      case 'login':
        if (success) {
          await this.emit(e.identity, (u) => new UserLogged(u));
        } else {
          // Only the audit reason: the event never carries the credentials that failed.
          await this.emit(e.identity, (u) => new UserLoginFailed(u, new InvalidCredentials(`Login failed: ${e.reason ?? 'unknown'}`)));
        }
        return;
      case 'password.change':
        if (success) {
          await this.emit(e.identity, (u) => (e.data?.expired === true ? new UserPasswordExpired(u) : new UserPasswordChanged(u)));
        }
        return;
      case 'password.reset':
        if (success) {
          await this.emit(e.identity, (u) => new UserPasswordChanged(u));
        }
        return;
      case 'password.reset.request':
        if (success) {
          await this.emit(e.identity, (u) => new UserPasswordChangeRequest(u));
        }
        return;
      case 'impersonation.start':
        if (success) {
          await this.emitPair(e, (impersonator, target) => new UserImpersonationStarted(impersonator, target));
        }
        return;
      case 'impersonation.end':
      case 'impersonation.expire':
        if (success) {
          await this.emitPair(e, (impersonator, target) => new UserImpersonationEnded(impersonator, target));
        }
        return;
    }
  }

  private async emit(ref: Ref | undefined, make: (u: User) => Parameters<typeof ev>[0]): Promise<void> {
    const u = await this.user(ref);
    if (u) {
      await ev(make(u));
    }
  }

  /** `actor` is the impersonator, `identity` the impersonated user. */
  private async emitPair(e: AuthnEvent, make: (impersonator: User, target: User) => Parameters<typeof ev>[0]): Promise<void> {
    const impersonator = await this.user(e.actor);
    const target = impersonator ? await this.user(e.identity) : undefined;
    if (impersonator && target) {
      await ev(make(impersonator, target));
    }
  }

  private async user(ref: Ref | undefined): Promise<User | undefined> {
    if (ref?.type !== 'user' || typeof ref.id !== 'string') {
      return undefined;
    }
    return (await User.query().withDeleted().where('Uuid', ref.id).first()) ?? undefined;
  }
}
