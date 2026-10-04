import { PasswordService } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef, PasswordChangeResult, PasswordExpiry, PasswordPolicy, PasswordResetRequestResult, PasswordResetResult, PasswordSetResult, PasswordViolation, PrincipalRef } from '@spinajs/authn/contracts';
import { DI } from '@spinajs/di';

import { PasswordProvider } from '../../src/interfaces.js';
import { User } from '../../src/models/User.js';

export interface PasswordCall {
  readonly method: 'set' | 'invite';
  readonly id: IdentityRef;
  readonly password?: string;
  readonly ctx: AuthnContext;
  readonly actor?: PrincipalRef;
}

/** Every set/invite since the last {@link resetPasswordCalls}. */
export const passwordCalls: PasswordCall[] = [];

export function resetPasswordCalls(): void {
  passwordCalls.length = 0;
}

/**
 * The PasswordService users' create() calls, until users ships its PasswordCredentialStore and the
 * suites can run authn-local's: the test config's rule (8+ characters with a digit), and `set` hashes
 * with the legacy provider into users.Password so the 2.x login tests still find the password.
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

    const hash = await ((await DI.resolve(PasswordProvider)) as PasswordProvider).hash(newPassword);
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

  public requestReset(): Promise<PasswordResetRequestResult> {
    throw new Error('TestPasswordService.requestReset is not used by users');
  }

  public redeemReset(): Promise<PasswordResetResult> {
    throw new Error('TestPasswordService.redeemReset is not used by users');
  }

  public expire(_id: IdentityRef, _opts: PasswordExpiry): Promise<void> {
    throw new Error('TestPasswordService.expire is not used by users');
  }
}
