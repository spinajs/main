import { PasswordService } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef, PasswordChangeResult, PasswordExpiry, PasswordPolicy, PasswordResetRequestResult, PasswordResetResult, PasswordSetResult, PasswordViolation, PrincipalRef } from '@spinajs/authn/contracts';
import { DI } from '@spinajs/di';
import { PasswordProvider, User } from '@spinajs/users';

export interface PasswordCall {
  readonly method: 'set' | 'invite' | 'requestReset' | 'redeemReset' | 'expire';
  readonly id?: IdentityRef;
  readonly login?: string;
  readonly expiry?: PasswordExpiry;
  readonly actor?: PrincipalRef;
}

/** Every call since the last {@link resetPasswordCalls}. */
export const passwordCalls: PasswordCall[] = [];

export function resetPasswordCalls(): void {
  passwordCalls.length = 0;
}

/**
 * The PasswordService users calls in the admin suites: `set` hashes with the legacy provider into users.Password,
 * `expire` writes authn-local's marker; the invite and reset calls only record.
 */
export class TestPasswordService extends PasswordService {
  public async check(password: string): Promise<readonly PasswordViolation[]> {
    return /^(?=.*\d).{8,}$/.test(password) ? [] : ['rule'];
  }

  public async set(id: IdentityRef, newPassword: string, _ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<PasswordSetResult> {
    passwordCalls.push({ method: 'set', id, ...(opts?.actor ? { actor: opts.actor } : {}) });
    const violations = await this.check(newPassword);
    if (violations.length > 0) {
      return { status: 'rejected', violations };
    }

    const hash = await ((await DI.resolve(PasswordProvider)) as PasswordProvider).hash(newPassword);
    await User.query().Driver.update().in(User.getModelDescriptor().TableName).update({ Password: hash }).where('Uuid', id.id);
    return { status: 'set' };
  }

  public async invite(id: IdentityRef, _ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<void> {
    passwordCalls.push({ method: 'invite', id, ...(opts?.actor ? { actor: opts.actor } : {}) });
  }

  public policy(): PasswordPolicy {
    return { minLength: 8, maxLength: 128 };
  }

  public change(): Promise<PasswordChangeResult> {
    throw new Error('TestPasswordService.change is not used by users-http');
  }

  public async requestReset(login: string): Promise<PasswordResetRequestResult> {
    passwordCalls.push({ method: 'requestReset', login });
    return { status: 'accepted' };
  }

  public async redeemReset(login: string): Promise<PasswordResetResult> {
    passwordCalls.push({ method: 'redeemReset', login });
    return { status: 'invalid' };
  }

  public async expire(id: IdentityRef, expiry: PasswordExpiry): Promise<void> {
    passwordCalls.push({ method: 'expire', id, expiry, ...(expiry.cause === 'admin' && expiry.actor ? { actor: expiry.actor } : {}) });
    await User.query().Driver.update().in(User.getModelDescriptor().TableName).update({ Password: '!expired' }).where('Uuid', id.id);
  }
}
