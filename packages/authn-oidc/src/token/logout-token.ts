import type { IdentityLinkStore, SessionIssuer } from '@spinajs/authn/contracts';

import type { OidcSigningAlgorithm } from '../contracts.js';
import type { OidcJwks } from '../jwks.js';
import type { OidcAnswer } from '../login.js';
import type { OidcStateStore } from '../provider.js';
import type { OidcStrategy } from '../strategy.js';

/** The `events` member that makes a JWT a logout token (OpenID Back-Channel Logout 1.0, section 2.4). */
export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

export interface LogoutTokenRules {
  readonly issuer: string;
  readonly issuerAliases: readonly string[];
  readonly clientId: string;
  readonly algorithms: readonly OidcSigningAlgorithm[];
  readonly clockSkewSeconds: number;
  readonly now: Date;
}

export interface LogoutTokenClaims {
  readonly iss: string;
  readonly jti: string;
  readonly sub?: string;
  readonly sid?: string;
  /** Until when the jti stays claimed: the token's exp, or iat plus the default lifetime, plus the clock skew. */
  readonly expiresAt: Date;
}

/** Section 2.6: signature, iss, aud, iat, exp, events, no nonce, a jti, and a sub or a sid. Throws on any failure. */
export async function validateLogoutToken(_token: string, _jwks: OidcJwks, _r: LogoutTokenRules): Promise<LogoutTokenClaims> {
  throw new Error('not implemented: validateLogoutToken');
}

export interface OidcBackchannelLogoutDeps {
  /** By provider name, as OidcProviders.strategies(). */
  readonly strategies: ReadonlyMap<string, OidcStrategy>;
  readonly sessions: SessionIssuer;
  /** Needed for a logout token that names only a `sub`. */
  readonly links: IdentityLinkStore | null;
  /** Claims each logout token's jti once. */
  readonly nonces: OidcStateStore;
  readonly log?: { warn(...args: unknown[]): void };
}

/** `POST /auth/oidc/:provider/backchannel-logout` (OpenID Back-Channel Logout 1.0). */
export class OidcBackchannelLogout {
  constructor(protected readonly d: OidcBackchannelLogoutDeps) {}

  /** `form` is the parsed application/x-www-form-urlencoded body; 200 on success, 400 `{ error: 'invalid_request' }` otherwise (section 2.8). */
  public async receive(_provider: string, _form: unknown, _now: Date): Promise<OidcAnswer> {
    throw new Error('not implemented: OidcBackchannelLogout.receive');
  }
}
