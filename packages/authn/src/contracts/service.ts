import { AsyncService } from '@spinajs/di';
import type { AuthenticationResult, AuthnContext, Credentials, IdentityRef } from './credentials.js';
import type { AuthnFacts, Ceiling, Principal } from './principal.js';
import type { SessionHandle } from './session.js';
import type { AuthenticationStrategy } from './strategy.js';

/** The entry point. One per app (root container). */
export abstract class AuthnService extends AsyncService {
  abstract authenticate(c: Credentials, ctx: AuthnContext): Promise<AuthenticationResult>;
  /** Step 'recovery' (POST /auth/mfa/recovery): `response` is a recovery code, checked by the pending steps' MfaStep.verifyRecovery (A10). */
  abstract completeMfa(pending: SessionHandle, step: string, response: string, ctx: AuthnContext): Promise<AuthenticationResult>;
  /**
   * Fresh authentication (A13). On success it refreshes authenticatedAt of the session's facts through SessionIssuer.elevate.
   * A throttled re-authentication returns false; the route answers like any failed re-authentication.
   */
  abstract reauthenticate(session: SessionHandle, c: Credentials, ctx: AuthnContext): Promise<boolean>;
  /** Via PrincipalFactory. */
  abstract principalOf(result: Extract<AuthenticationResult, { status: 'success' }>): Promise<Principal>;
  abstract strategies(): readonly AuthenticationStrategy[];
}

/** users: UserPrincipalFactory; apps: service and agent principals. */
export abstract class PrincipalFactory {
  /** extra.attributes are merged into Principal.attributes; they add attributes only, never authority (§18.3(e)). */
  abstract principalOf(id: IdentityRef, facts: AuthnFacts, extra: { ceiling?: Ceiling; onBehalfOf?: Principal; delegation?: 'inherit' | 'intersect'; readonly attributes?: Readonly<Record<string, unknown>> }): Promise<Principal>;
}
