import { BadRequestResponse, Conflict, ForbiddenResponse, NotFound, Ok } from '@spinajs/http';
import type { KeyChallenge, KeyProof, KeyRecord, KeyRegisterResult, NewKey, PublicJwk, Session } from '@spinajs/authn/contracts';

import { KEY_NAME_CAP } from '../dto/keys.js';
import type { AuthnKeyRegisterBody } from '../dto/keys.js';
import { tooManyRequests } from '../password/fields.js';
import type { TooManyRequestsResponse } from '../password/fields.js';
import { refused } from '../policies/v3/errors.js';
import { activeSessionOf, authenticatedPrincipal, isSessionPrincipal } from '../policies/v3/principal.js';
import { expiryOf } from '../token/fields.js';
import type { InputAnswer } from '../validation/answers.js';
import { unknownField } from '../validation/answers.js';
import type { AuthnClientContext } from '../v3/client.js';
import { NO_STORE, badRequest, hookRefusedAnswer, instant } from '../v3/responses.js';

// Answers of the 3.0 key routes; the DTOs of dto/keys.ts check and cap every field before KeyRegistry sees it. No answer
// but the challenge answer carries a challenge.

/** Far above any Ed25519 or P-256 public JWK. */
const JWK_JSON_CAP = 512;

export const invalidKey = (): BadRequestResponse => badRequest('invalid_key', 'jwk must be an Ed25519 or P-256 public key');
export const invalidKid = (): BadRequestResponse => badRequest('invalid_kid', 'kid must be 1-64 characters of A-Z, a-z, 0-9, ".", "_" and "-"');
export const invalidKeyName = (): BadRequestResponse => badRequest('invalid_name', `name must be a non-empty string of at most ${KEY_NAME_CAP} characters without control characters`);
export const invalidKeyExpiry = (): BadRequestResponse => badRequest('invalid_expiry', 'expiresAt must be an ISO 8601 instant after now');
export const invalidProof = (): BadRequestResponse => badRequest('invalid_proof', 'proof must be { challengeId, signature } of a register challenge');
export const invalidPurpose = (): BadRequestResponse => badRequest('invalid_purpose', 'purpose must be login or register');

/** A `scope` is refused rather than dropped, so nobody gets an unscoped key while asking for a scoped one. */
export const unknownKeyField: InputAnswer = (input, err, ctx) => (input.unknown.includes('scope') ? badRequest('invalid_scope', 'a user key takes no scope here') : unknownField(input, err, ctx));

/**
 * The caller's own active session for a key management route: 401 without an authenticated principal (a pending session
 * yields none), 403 `session_required` for a per-request credential (no token or key manages keys), 403 `impersonating`
 * (a key added there would outlive the impersonation).
 */
export function keyManager(client: AuthnClientContext): Session {
  const principal = authenticatedPrincipal(client);
  if (!isSessionPrincipal(principal)) throw refused('session_required', 'this route needs a session, not a per-request credential');
  if (principal.authn?.impersonator !== undefined) throw refused('impersonating', 'this route cannot be used while impersonating another user');
  const session = activeSessionOf(client, 'this route needs the session of a user');
  if (session.identity.type !== 'user') throw refused('session_required', 'this route needs the session of a user');
  return session;
}

/** One answer for a foreign, an unknown and a malformed kid, so the route tells nothing about other owners' keys. */
export const keyNotFound = (): NotFound => new NotFound({ error: 'key_not_found', message: 'No such key' }, { Headers: [NO_STORE] });

/** KeyRegistry's refusal of a registration; an `authn.key.register` hook's is 403 `{ code }`. */
export function registerRefusal(result: Extract<KeyRegisterResult, { ok: false }>): BadRequestResponse | ForbiddenResponse {
  if (result.code === 'refused') return hookRefusedAnswer(result.refusal);
  const code = result.code;
  if (code === 'duplicate') return new Conflict({ error: 'key_taken', message: 'this key or kid is already registered' }, { Headers: [NO_STORE] });
  if (code === 'invalid_proof') return badRequest('invalid_proof', 'the proof must be a signature of the new key over a register challenge of this user');
  return badRequest('invalid_key', 'jwk must be an Ed25519 or P-256 public key');
}

/**
 * The new key of a POST /user/keys body, or its 400 answer: the public JWK as JSON text within its cap, and an
 * `expiresAt` after `now`. KeyRegistry checks the key itself and the proof.
 */
export function keyRequestOf(body: AuthnKeyRegisterBody, now: Date): { key: NewKey & { proof: KeyProof } } | { answer: BadRequestResponse } {
  if (JSON.stringify(body.jwk).length > JWK_JSON_CAP) return { answer: invalidKey() };
  const expiresAt = body.expiresAt === undefined ? undefined : expiryOf(body.expiresAt);
  if (expiresAt === null || (expiresAt !== undefined && expiresAt.getTime() <= now.getTime())) return { answer: invalidKeyExpiry() };
  const { kid, name } = body;
  const proof = { challengeId: body.proof.challengeId, signature: body.proof.signature };
  const key = { jwk: body.jwk as unknown as PublicJwk, proof, ...(kid !== undefined ? { kid } : {}), ...(name !== undefined ? { name } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) };
  return { key };
}

export const challengeAnswer = (c: KeyChallenge): Ok => new Ok({ id: c.id, nonce: c.nonce, expiresAt: c.expiresAt.toISOString() }, { Headers: [NO_STORE] });

/** 429 for a throttled login challenge. Its key is the client ip alone, so a known and an unknown kid throttle alike. */
export const challengeThrottled = (retryAfterSeconds: number): TooManyRequestsResponse => tooManyRequests('too many key challenges, try again later', retryAfterSeconds);

/** The wire shape of one key: public material only, revoked and expired keys marked, absent values null. */
export function keyEntry(r: KeyRecord, now: Date): Record<string, unknown> {
  const jwk = r.jwk.kty === 'OKP' ? { kty: r.jwk.kty, crv: r.jwk.crv, x: r.jwk.x } : { kty: r.jwk.kty, crv: r.jwk.crv, x: r.jwk.x, y: r.jwk.y };
  return {
    kid: r.kid,
    name: r.name ?? null,
    alg: r.alg,
    jwk,
    thumbprint: r.thumbprint,
    scope: r.scope ? (JSON.parse(JSON.stringify(r.scope)) as unknown) : null,
    createdAt: instant(r.createdAt),
    expiresAt: instant(r.expiresAt),
    lastUsedAt: instant(r.lastUsedAt),
    revokedAt: instant(r.revokedAt),
    revoked: r.revokedAt !== undefined,
    expired: r.expiresAt !== undefined && r.expiresAt.getTime() <= now.getTime(),
  };
}
