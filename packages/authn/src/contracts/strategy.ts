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
  /**
   * Throttle keys this attempt counts against (account key needs the login string).
   * Non-interactive strategies (token, keys, jwt) return an account key and an account-ip key derived from the credential's stable id
   * (e.g. token id, key id; never the raw secret). Non-interactive strategies count only their failures in the 'login' flow: the
   * service peeks before verify and counts after a failure, so parallel requests on a valid credential never back off (K5), and it
   * scopes their account key by the client ip, so failures sent from elsewhere never delay the credential's owner (K6). A parallel
   * burst is verified in full, so they must take only unguessable credentials (128 bits or more, or signatures).
   */
  abstract throttleKeys(c: Credentials, ctx: AuthnContext): readonly ThrottleKey[];
  /** Verify only; no session, no MFA, no events: AuthnService does those. Must take the same time for unknown accounts (A02). */
  abstract verify(c: Credentials, ctx: AuthnContext): Promise<StrategyOutcome>;
}
