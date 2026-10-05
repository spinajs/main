import { BadRequestResponse, Conflict, HTTP_STATUS_CODE, NotFound, Ok } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import type { Credentials, KeyChallenge, KeyProof, KeyRecord, KeyRegisterResult, NewKey, PublicJwk } from '@spinajs/authn/contracts';

import { refused } from '../policies/v3/errors.js';
import { authenticatedPrincipal, isSessionPrincipal } from '../policies/v3/principal.js';
import { badRequest, expiryOf } from '../token/fields.js';
import { NO_STORE } from '../v3/responses.js';
import { bodyField, boundedString } from '../v3/routes.js';
import type { Restored } from '../v3/routes.js';

// Body fields and answers of the 3.0 key routes. Every field is checked and capped before KeyRegistry sees it; no answer
// but the challenge answer carries a challenge.

const KID = /^[A-Za-z0-9._-]{1,64}$/;
/** Far above any Ed25519 or P-256 public JWK. */
const JWK_JSON_CAP = 512;
/** authn-keys' own limit on a key name. */
const NAME_CAP = 128;
/** Above authn-keys' longest challenge id (16 + 1 + 512). */
const CHALLENGE_ID_CAP = 600;
/** Ed25519 and P-256 (IEEE P1363) signatures are 64 bytes, 86 characters of base64url. */
const SIGNATURE_CAP = 128;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const kidOf = (value: unknown): string | null => (typeof value === 'string' && KID.test(value) ? value : null);

/**
 * The caller's own active session for a key management route: 401 without an authenticated principal (a pending session
 * yields none), 403 `session_required` for a per-request credential (no token or key manages keys), 403 `impersonating`
 * (a key added there would outlive the impersonation).
 */
export function keyManager(req: Request): Restored {
  const principal = authenticatedPrincipal(req);
  if (!isSessionPrincipal(principal)) throw refused('session_required', 'this route needs a session, not a per-request credential');
  if (principal.authn?.impersonator !== undefined) throw refused('impersonating', 'this route cannot be used while impersonating another user');
  const session = req.storage.AuthnSession;
  if (session?.handle.state !== 'active' || session.identity.type !== 'user') throw refused('session_required', 'this route needs the session of a user');
  return session;
}

/** One answer for a foreign, an unknown and a malformed kid, so the route tells nothing about other owners' keys. */
export const keyNotFound = (): NotFound => new NotFound({ error: 'key_not_found', message: 'No such key' }, { Headers: [NO_STORE] });

/** KeyRegistry's refusal of a registration. */
export function registerRefusal(code: Extract<KeyRegisterResult, { ok: false }>['code']): BadRequestResponse {
  if (code === 'duplicate') return new Conflict({ error: 'key_taken', message: 'this key or kid is already registered' }, { Headers: [NO_STORE] });
  if (code === 'invalid_proof') return badRequest('invalid_proof', 'the proof must be a signature of the new key over a register challenge of this user');
  return badRequest('invalid_key', 'jwk must be an Ed25519 or P-256 public key');
}

/**
 * The new key of a POST /user/keys body, or its 400 answer: `jwk` (public, Ed25519 or P-256), `proof` `{ challengeId,
 * signature }`, optional `kid` (default: the RFC 7638 thumbprint), `name` and `expiresAt` (ISO 8601). A `scope` is
 * refused rather than dropped, so nobody gets an unscoped key while asking for a scoped one. KeyRegistry checks the key
 * itself and the proof.
 */
export function keyRequestOf(req: Request, now: Date): { key: NewKey & { proof: KeyProof } } | { answer: BadRequestResponse } {
  const jwk = bodyField(req, 'jwk');
  if (!isPlainObject(jwk) || JSON.stringify(jwk).length > JWK_JSON_CAP) return { answer: badRequest('invalid_key', 'jwk must be an Ed25519 or P-256 public key') };
  const rawKid = bodyField(req, 'kid');
  const kid = rawKid === undefined ? undefined : kidOf(rawKid);
  if (kid === null) return { answer: badRequest('invalid_kid', 'kid must be 1-64 characters of A-Z, a-z, 0-9, ".", "_" and "-"') };
  const rawName = bodyField(req, 'name');
  const name = rawName === undefined ? undefined : boundedString(rawName, NAME_CAP);
  if (name === null || (name !== undefined && CONTROL_CHARACTERS.test(name))) return { answer: badRequest('invalid_name', `name must be a non-empty string of at most ${NAME_CAP} characters without control characters`) };
  const rawExpiry = bodyField(req, 'expiresAt');
  const expiresAt = rawExpiry === undefined ? undefined : expiryOf(rawExpiry);
  if (expiresAt === null || (expiresAt !== undefined && expiresAt.getTime() <= now.getTime())) return { answer: badRequest('invalid_expiry', 'expiresAt must be an ISO 8601 instant after now') };
  if (bodyField(req, 'scope') !== undefined) return { answer: badRequest('invalid_scope', 'a user key takes no scope here') };
  const proof = bodyField(req, 'proof');
  const challengeId = isPlainObject(proof) ? boundedString(proof.challengeId, CHALLENGE_ID_CAP) : null;
  const signature = isPlainObject(proof) ? boundedString(proof.signature, SIGNATURE_CAP) : null;
  if (challengeId === null || signature === null) return { answer: badRequest('invalid_proof', 'proof must be { challengeId, signature } of a register challenge') };
  const key = { jwk: jwk as unknown as PublicJwk, proof: { challengeId, signature }, ...(kid !== undefined ? { kid } : {}), ...(name !== undefined ? { name } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) };
  return { key };
}

/** A POST /auth/keys/challenge body: `{ purpose: 'login', kid }` or `{ purpose: 'register' }`, or its 400 answer. */
export function challengeRequestOf(req: Request): { purpose: 'login'; kid: string } | { purpose: 'register' } | { answer: BadRequestResponse } {
  const purpose = bodyField(req, 'purpose');
  if (purpose === 'register') return { purpose };
  if (purpose !== 'login') return { answer: badRequest('invalid_purpose', 'purpose must be login or register') };
  const kid = kidOf(bodyField(req, 'kid'));
  if (kid === null) return { answer: badRequest('invalid_kid', 'kid must be 1-64 characters of A-Z, a-z, 0-9, ".", "_" and "-"') };
  return { purpose, kid };
}

export const challengeAnswer = (c: KeyChallenge): Ok => new Ok({ id: c.id, nonce: c.nonce, expiresAt: c.expiresAt.toISOString() }, { Headers: [NO_STORE] });

/** 429 for a throttled login challenge. Its key is the client ip alone, so a known and an unknown kid throttle alike. */
export function challengeThrottled(retryAfterSeconds: number): Ok {
  return new Ok({ error: 'throttled', message: 'too many key challenges, try again later' }, { StatusCode: HTTP_STATUS_CODE.TOO_MANY_REQUESTS, Headers: [NO_STORE, { Name: 'Retry-After', Value: String(Math.max(0, Math.ceil(retryAfterSeconds))) }] });
}

/** The key-challenge credentials of a POST /auth/keys/login body `{ keyId, challengeId, signature }`, or null when one is missing or over its cap. */
export function keyLoginCredentialsOf(req: Request): Credentials | null {
  const keyId = kidOf(bodyField(req, 'keyId'));
  const challengeId = boundedString(bodyField(req, 'challengeId'), CHALLENGE_ID_CAP);
  const signature = boundedString(bodyField(req, 'signature'), SIGNATURE_CAP);
  return keyId !== null && challengeId !== null && signature !== null ? { kind: 'key-challenge', keyId, challengeId, signature } : null;
}

/** An instant to the second, as authn_key keeps it. */
const instant = (d: Date | undefined): string | null => (d ? new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString() : null);

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
