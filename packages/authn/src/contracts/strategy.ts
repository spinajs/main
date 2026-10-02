import { AsyncService } from '@spinajs/di';
import type { AuthnContext, Credentials, StrategyOutcome } from './credentials.js';
import type { ThrottleKey } from './throttle.js';

/** A login method. Registered with @Injectable(AuthenticationStrategy); selected by authn.strategies. */
export abstract class AuthenticationStrategy extends AsyncService {
  /** e.g. 'local', 'token', 'jwt', 'keys', 'oidc:google' */
  abstract readonly name: string;
  /** Credential kinds it accepts. */
  abstract readonly kinds: readonly string[];
  /** True: may start a session (password, oidc); false: per request (token, signature). */
  abstract readonly interactive: boolean;
  /** Throttle keys this attempt counts against (account key needs the login string). */
  abstract throttleKeys(c: Credentials, ctx: AuthnContext): readonly ThrottleKey[];
  /** Verify only; no session, no MFA, no events: AuthnService does those. Must take the same time for unknown accounts (A02). */
  abstract verify(c: Credentials, ctx: AuthnContext): Promise<StrategyOutcome>;
}
