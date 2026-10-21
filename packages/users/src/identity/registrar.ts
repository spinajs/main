import type { IContainer } from '@spinajs/di';
import { IdentityRegistrar } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef } from '@spinajs/authn/contracts';

/** Self-service registration over `create()` (FEAT-4, A35). */
export class UserIdentityRegistrar extends IdentityRegistrar {
  public register(_data: { readonly login: string; readonly email: string; readonly password: string }, _ctx: AuthnContext): Promise<{ readonly status: 'created'; readonly id: IdentityRef } | { readonly status: 'exists'; readonly id: IdentityRef }> {
    return Promise.reject(new Error('not implemented: UserIdentityRegistrar.register'));
  }
}

/** The IdentityRegistrar for `users.registration.enabled`: none while it is off, so the registration route answers 404. */
export function identityRegistrar(_container: IContainer): UserIdentityRegistrar | null {
  throw new Error('not implemented: identityRegistrar');
}
