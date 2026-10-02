import { AsyncService } from '@spinajs/di';
import type { AuthenticationResult, AuthnContext, Credentials, IdentityRef } from './credentials.js';
import type { AuthnFacts, Ceiling, Principal } from './principal.js';
import type { SessionHandle } from './session.js';
import type { AuthenticationStrategy } from './strategy.js';

/** The entry point. One per app (root container). */
export abstract class AuthnService extends AsyncService {
  abstract authenticate(c: Credentials, ctx: AuthnContext): Promise<AuthenticationResult>;
  abstract completeMfa(pending: SessionHandle, step: string, response: string, ctx: AuthnContext): Promise<AuthenticationResult>;
  /** Fresh authentication (A13). */
  abstract reauthenticate(session: SessionHandle, c: Credentials, ctx: AuthnContext): Promise<boolean>;
  /** Via PrincipalFactory. */
  abstract principalOf(result: Extract<AuthenticationResult, { status: 'success' }>): Promise<Principal>;
  abstract strategies(): readonly AuthenticationStrategy[];
}

/** users: UserPrincipalFactory; apps: service and agent principals. */
export abstract class PrincipalFactory {
  abstract principalOf(id: IdentityRef, facts: AuthnFacts, extra: { ceiling?: Ceiling; onBehalfOf?: Principal; delegation?: 'inherit' | 'intersect' }): Promise<Principal>;
}
