import { AuthnEventSink, PasswordService } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef, PasswordChangeResult, PasswordExpiry, PasswordPolicy, PasswordResetRequestResult, PasswordResetResult, PasswordSetResult, PasswordViolation, PrincipalRef } from '@spinajs/authn/contracts';
import { DI } from '@spinajs/di';

import { testHasher } from './hasher.js';
import { User } from '../../src/models/User.js';

export interface PasswordCall {
  readonly method: 'set' | 'invite' | 'requestReset' | 'redeemReset' | 'expire';
  readonly id?: IdentityRef;
  readonly login?: string;
  readonly secret?: string;
  readonly password?: string;
  readonly expiry?: PasswordExpiry;
  readonly ctx: AuthnContext;
  readonly actor?: PrincipalRef;
}

/** Every call since the last {@link resetPasswordCalls}. */
export const passwordCalls: PasswordCall[] = [];

export function resetPasswordCalls(): void {
  passwordCalls.length = 0;
}

/**
 * The PasswordService users calls in the suites: the test config's rule (8+ characters with a digit); `set` hashes
 * with the legacy provider into users.Password so the 2.x login tests still find the password; `expire` writes
 * authn-local's marker and publishes its event to the registered sinks, as authn-local does. The reset calls only
 * record (tests stub their answers).
 */
export class TestPasswordService extends PasswordService {
  public async check(password: string): Promise<readonly PasswordViolation[]> {
    return /^(?=.*\d).{8,}$/.test(password) ? [] : ['rule'];
  }

  public async set(id: IdentityRef, newPassword: string, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<PasswordSetResult> {
    passwordCalls.push({ method: 'set', id, password: newPassword, ctx, ...(opts?.actor ? { actor: opts.actor } : {}) });
    const violations = await this.check(newPassword);
    if (violations.length > 0) {
      return { status: 'rejected', violations };
    }

    const hash = await testHasher.hash(newPassword);
    await User.query().Driver.update().in(User.getModelDescriptor().TableName).update({ Password: hash }).where('Uuid', id.id);
    return { status: 'set' };
  }

  public async invite(id: IdentityRef, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<void> {
    passwordCalls.push({ method: 'invite', id, ctx, ...(opts?.actor ? { actor: opts.actor } : {}) });
  }

  public policy(): PasswordPolicy {
    return { minLength: 8, maxLength: 128 };
  }

  public change(): Promise<PasswordChangeResult> {
    throw new Error('TestPasswordService.change is not used by users');
  }

  public async requestReset(login: string, ctx: AuthnContext): Promise<PasswordResetRequestResult> {
    passwordCalls.push({ method: 'requestReset', login, ctx });
    return { status: 'accepted' };
  }

  public async redeemReset(login: string, secret: string, newPassword: string, ctx: AuthnContext): Promise<PasswordResetResult> {
    passwordCalls.push({ method: 'redeemReset', login, secret, password: newPassword, ctx });
    return { status: 'invalid' };
  }

  public async expire(id: IdentityRef, expiry: PasswordExpiry, ctx: AuthnContext): Promise<void> {
    passwordCalls.push({ method: 'expire', id, expiry, ctx });
    await User.query().Driver.update().in(User.getModelDescriptor().TableName).update({ Password: '!expired' }).where('Uuid', id.id);

    const actor = expiry.cause === 'admin' ? { actor: expiry.actor } : {};
    for (const sink of await DI.resolve(Array.ofType(AuthnEventSink))) {
      await sink.publish({ type: 'password.change', outcome: 'success', at: ctx.now, identity: id, ...actor, data: { cause: expiry.cause, expired: true } });
    }
  }
}
