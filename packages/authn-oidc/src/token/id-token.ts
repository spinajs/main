import { createHash, timingSafeEqual } from 'node:crypto';
import { compactVerify, decodeProtectedHeader } from 'jose';
import { isFiniteNumber } from '@spinajs/util';
import { AuthenticationFailed } from '@spinajs/exceptions';

import type { OidcSigningAlgorithm } from '../contracts.js';
import type { OidcJwks } from '../jwks.js';
import { isPlainObject } from '../support.js';

export interface IdTokenRules {
  readonly issuer: string;
  readonly issuerAliases: readonly string[];
  readonly clientId: string;
  /** A subset of OIDC_SIGNING_ALGORITHMS: never none, never HMAC. */
  readonly algorithms: readonly OidcSigningAlgorithm[];
  readonly clockSkewSeconds: number;
  readonly nonce: string;
  readonly accessToken: string;
  readonly now: Date;
  /** A re-authentication's flow start, unix seconds: auth_time must be given and no earlier, within the clock skew. */
  readonly authenticatedSince?: number;
}

export type IdTokenClaims = Readonly<Record<string, unknown>>;

const COMPACT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_SUBJECT = 255;

/** OIDC Core §3.1.3.6: the hash of the alg's JWS hash function (Ed25519 signs with SHA-512). */
function atHashAlgorithm(alg: OidcSigningAlgorithm): string {
  if (alg.endsWith('256')) return 'sha256';
  if (alg.endsWith('384')) return 'sha384';
  return 'sha512';
}

export function atHashOf(accessToken: string, alg: OidcSigningAlgorithm): string {
  const digest = createHash(atHashAlgorithm(alg)).update(accessToken, 'ascii').digest();
  return digest.subarray(0, digest.length / 2).toString('base64url');
}

const sameText = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * OIDC Core §3.1.3.7 (D10): signature with an allowed algorithm and a provider key, then iss, aud, azp, exp, iat, nbf,
 * nonce, sub, at_hash and, for a re-authentication, auth_time. Throws on any failure; the message names the check, never a token.
 */
export async function validateIdToken(token: string, jwks: OidcJwks, r: IdTokenRules): Promise<IdTokenClaims> {
  const refuse = (what: string): never => {
    throw new AuthenticationFailed(`authn-oidc: ID token refused: ${what}`);
  };
  if (!COMPACT.test(token)) refuse('not a signed compact JWS');

  const header = decodeProtectedHeader(token) as Record<string, unknown>;
  const alg = header.alg;
  if (typeof alg !== 'string' || !(r.algorithms as readonly string[]).includes(alg)) refuse('algorithm not allowed');
  if (header.crit !== undefined) refuse('crit header');
  if (header.kid !== undefined && typeof header.kid !== 'string') refuse('kid');

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
  if (c.azp !== undefined && c.azp !== r.clientId) refuse('azp');
  if (Array.isArray(aud) && aud.length > 1 && c.azp === undefined) refuse('azp');

  const now = r.now.getTime() / 1000;
  const skew = r.clockSkewSeconds;
  if (!isFiniteNumber(c.exp) || c.exp + skew <= now) refuse('exp');
  if (!isFiniteNumber(c.iat) || c.iat > now + skew) refuse('iat');
  if (c.nbf !== undefined && (!isFiniteNumber(c.nbf) || c.nbf > now + skew)) refuse('nbf');

  if (typeof c.nonce !== 'string' || !sameText(c.nonce, r.nonce)) refuse('nonce');
  if (typeof c.sub !== 'string' || c.sub.length === 0 || c.sub.length > MAX_SUBJECT) refuse('sub');
  if (c.at_hash !== undefined && (typeof c.at_hash !== 'string' || !sameText(c.at_hash, atHashOf(r.accessToken, alg as OidcSigningAlgorithm)))) refuse('at_hash');
  if (r.authenticatedSince !== undefined && (!isFiniteNumber(c.auth_time) || c.auth_time + skew < r.authenticatedSince || c.auth_time > now + skew)) refuse('auth_time');

  return Object.freeze({ ...c });
}
