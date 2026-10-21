import { createHash } from 'node:crypto';
import { compactVerify, decodeProtectedHeader } from 'jose';
import { isFiniteNumber } from '@spinajs/util';
import { AuthenticationFailed } from '@spinajs/exceptions';
import type { IdentityLinkStore, SessionIssuer } from '@spinajs/authn/contracts';

import type { OidcSigningAlgorithm } from '../contracts.js';
import type { OidcJwks } from '../jwks.js';
import type { OidcAnswer } from '../login.js';
import type { OidcStateStore } from '../provider.js';
import type { OidcStrategy } from '../strategy.js';
import { MAX_SUBJECT_LENGTH } from '../claims.js';
import { isPlainObject } from '../support.js';

/** The `events` member that makes a JWT a logout token (OpenID Back-Channel Logout 1.0, section 2.4). */
export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/** How long a logout token without `exp` is accepted after its `iat`. */
export const LOGOUT_TOKEN_MAX_AGE_SECONDS = 300;

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

const COMPACT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 16_384;
const MAX_JTI_LENGTH = 255;
const MAX_SID_LENGTH = 255;
/** Explicit typing (section 2.4); an ID token or an access token must not pass as a logout token. */
const LOGOUT_TYPES = new Set(['jwt', 'logout+jwt', 'application/jwt', 'application/logout+jwt']);

const isPart = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Section 2.6: signature, iss, aud, iat, exp, events, no nonce, a jti, and a sub or a sid. Throws on any failure. */
export async function validateLogoutToken(token: string, jwks: OidcJwks, r: LogoutTokenRules): Promise<LogoutTokenClaims> {
  const refuse = (what: string): never => {
    throw new AuthenticationFailed(`authn-oidc: logout token refused: ${what}`);
  };
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !COMPACT.test(token)) refuse('not a signed compact JWS');

  const header = decodeProtectedHeader(token) as Record<string, unknown>;
  const alg = header.alg;
  if (typeof alg !== 'string' || !(r.algorithms as readonly string[]).includes(alg)) refuse('algorithm not allowed');
  if (header.crit !== undefined) refuse('crit header');
  if (header.kid !== undefined && typeof header.kid !== 'string') refuse('kid');
  if (header.typ !== undefined && !(typeof header.typ === 'string' && LOGOUT_TYPES.has(header.typ.toLowerCase()))) refuse('typ');

  const key = await jwks.key({ alg: alg as string, ...(header.kid !== undefined ? { kid: header.kid as string } : {}) }, r.now.getTime());
  const { payload } = await compactVerify(token, key, { algorithms: [alg as string] });

  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch {
    return refuse('payload is not JSON');
  }
  if (!isPlainObject(claims)) return refuse('payload is not an object');
  const c = claims;

  if (typeof c.iss !== 'string' || !(c.iss === r.issuer || r.issuerAliases.includes(c.iss))) refuse('iss');
  const aud = c.aud;
  const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : [];
  if (audiences.length === 0 || !audiences.every((a) => a === r.clientId)) refuse('aud');

  const now = r.now.getTime() / 1000;
  const skew = r.clockSkewSeconds;
  if (!isFiniteNumber(c.iat) || c.iat > now + skew) refuse('iat');
  if (c.exp !== undefined && !isFiniteNumber(c.exp)) refuse('exp');
  const until = (c.exp as number | undefined) ?? (c.iat as number) + LOGOUT_TOKEN_MAX_AGE_SECONDS;
  if (until + skew <= now) refuse('expired');
  if (c.nbf !== undefined && (!isFiniteNumber(c.nbf) || c.nbf > now + skew)) refuse('nbf');

  const events = c.events;
  if (!isPlainObject(events) || !Object.hasOwn(events, BACKCHANNEL_LOGOUT_EVENT) || !isPlainObject(events[BACKCHANNEL_LOGOUT_EVENT])) refuse('events');
  // Section 2.4: a nonce is prohibited, so an ID token never passes as a logout token.
  if (Object.hasOwn(c, 'nonce')) refuse('nonce');
  if (!isPart(c.jti, MAX_JTI_LENGTH)) refuse('jti');

  const sub = c.sub === undefined ? undefined : isPart(c.sub, MAX_SUBJECT_LENGTH) ? c.sub : refuse('sub');
  const sid = c.sid === undefined ? undefined : isPart(c.sid, MAX_SID_LENGTH) ? c.sid : refuse('sid');
  if (sub === undefined && sid === undefined) refuse('neither sub nor sid');

  return Object.freeze({
    iss: c.iss as string,
    jti: c.jti as string,
    ...(sub !== undefined ? { sub } : {}),
    ...(sid !== undefined ? { sid } : {}),
    expiresAt: new Date((until + skew) * 1000),
  });
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

const NO_STORE = Object.freeze({ 'cache-control': 'no-store' });
const DONE: OidcAnswer = Object.freeze({ status: 200, cookies: [], headers: NO_STORE });
const INVALID: OidcAnswer = Object.freeze({ status: 400, cookies: [], headers: NO_STORE, body: Object.freeze({ error: 'invalid_request' }) });

/** NonceStore keys are at most 160 chars: the jti goes in hashed, with the issuer that minted it. */
const jtiKey = (provider: string, iss: string, jti: string): string => `oidc-logout:${createHash('sha256').update(`${provider}\0${iss}\0${jti}`).digest('hex')}`;

/**
 * `POST /auth/oidc/:provider/backchannel-logout` (OpenID Back-Channel Logout 1.0). A token with `sid` ends the sessions
 * of that IdP session; one with only `sub` ends every session of the identity linked to that subject, impersonations
 * included. A valid token that matches no session still answers 200.
 */
export class OidcBackchannelLogout {
  constructor(protected readonly d: OidcBackchannelLogoutDeps) {}

  /** `form` is the parsed application/x-www-form-urlencoded body; 200 on success, 400 `{ error: 'invalid_request' }` otherwise (section 2.8). */
  public async receive(provider: string, form: unknown, now: Date): Promise<OidcAnswer> {
    const strategy = typeof provider === 'string' ? this.d.strategies.get(provider) : undefined;
    const token = isPlainObject(form) ? form.logout_token : undefined;
    const p = strategy?.provider;
    if (!strategy || !p || p.jwks === null || p.options.issuer === null || typeof token !== 'string') return INVALID;

    let claims: LogoutTokenClaims;
    try {
      claims = await validateLogoutToken(token, p.jwks, {
        issuer: p.options.issuer,
        issuerAliases: p.options.issuerAliases,
        clientId: p.options.clientId,
        algorithms: p.options.algorithms,
        clockSkewSeconds: p.options.clockSkewSeconds,
        now,
      });
    } catch (err) {
      this.d.log?.warn(`authn-oidc: back-channel logout for ${provider} refused: ${err instanceof Error ? err.message : String(err)}`);
      return INVALID;
    }

    try {
      if (!(await this.d.nonces.claim(jtiKey(strategy.name, claims.iss, claims.jti), claims.expiresAt, now))) {
        this.d.log?.warn(`authn-oidc: back-channel logout for ${provider} refused: jti replayed`);
        return INVALID;
      }
      if (claims.sid !== undefined) {
        await this.d.sessions.revokeByExternal(strategy.name, claims.sid);
      } else {
        const link = this.d.links ? await this.d.links.find(strategy.name, claims.sub!) : null;
        if (link) await this.d.sessions.revokeAll(link.identity, { includeImpersonations: true });
      }
    } catch (err) {
      this.d.log?.warn(`authn-oidc: back-channel logout for ${provider} failed: ${err instanceof Error ? err.message : String(err)}`);
      return INVALID;
    }
    return DONE;
  }
}
