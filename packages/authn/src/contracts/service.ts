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
   * Fresh authentication (A13). A success counts for the current request only: it changes no session facts and does not rotate the id.
   * A throttled re-authentication returns false; the route answers like any failed re-authentication.
   */
  abstract reauthenticate(session: SessionHandle, c: Credentials, ctx: AuthnContext): Promise<boolean>;
  /** Via PrincipalFactory. */
  abstract principalOf(result: Extract<AuthenticationResult, { status: 'success' }>): Promise<Principal>;
  abstract strategies(): readonly AuthenticationStrategy[];
}

/** users: UserPrincipalFactory; apps: service and agent principals. */
export abstract class PrincipalFactory {
  /** extra.attributes come from the strategy (see StrategyOutcome.attributes); keys this factory or a PrincipalAttributeProvider derives win over them (§18.3(e)). */
  abstract principalOf(id: IdentityRef, facts: AuthnFacts, extra: { ceiling?: Ceiling; onBehalfOf?: Principal; delegation?: 'inherit' | 'intersect'; attributes?: Readonly<Record<string, unknown>> }): Promise<Principal>;
}
