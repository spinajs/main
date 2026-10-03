import { randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { KeyAlgorithm, KeyChallenge, KeyMaterial } from '@spinajs/authn/contracts';
import { decodeB64url, encodeB64url } from '../jwk/base64url.js';
import { signRaw, verifySignature } from '../jwk/signature.js';

export type ChallengePurpose = 'register' | 'login';

/** The SecretStore purpose of one challenge; `rid` keeps it within authn_secret.purpose (varchar 32). */
export const challengeSecretPurpose = (rid: string): string => `key-challenge:${rid}`;

const RID_BYTES = 12;
const RID_LENGTH = 16;
const RID = /^[A-Za-z0-9_-]{16}$/;
const MAX_NONCE_LENGTH = 512;
const NONCE = /^[A-Za-z0-9_-]{22,512}$/;

export const newChallengeRid = (): string => randomBytes(RID_BYTES).toString('base64url');

/**
 * `<rid>.<nonce>`. SecretStore keeps only a hash of the nonce and redeems by the raw value, and the credentials carry
 * only the challenge id and a signature, so the id has to bring the nonce back.
 */
export const challengeId = (rid: string, nonce: string): string => `${rid}.${nonce}`;

export function parseChallengeId(id: unknown): { rid: string; nonce: string } | null {
  if (typeof id !== 'string' || id.length <= RID_LENGTH + 1 || id.length > RID_LENGTH + 1 + MAX_NONCE_LENGTH || id[RID_LENGTH] !== '.') {
    return null;
  }
  const rid = id.slice(0, RID_LENGTH);
  const nonce = id.slice(RID_LENGTH + 1);
  return RID.test(rid) && isChallengeNonce(nonce) ? { rid, nonce } : null;
}

/** Nonces are base64url, so the first ':' after one ends it and the signing input has exactly one reading. */
export const isChallengeNonce = (nonce: unknown): nonce is string => typeof nonce === 'string' && NONCE.test(nonce);

/**
 * The bytes a key signs to answer a challenge: UTF-8 of `spinajs-key-<purpose>:<nonce>:<audience>`. The purpose keeps
 * a login signature from proving a registration; the audience is the service as the client knows it (never taken from
 * the challenge answer), so a service that relays another one's challenge gets a signature the other one refuses.
 */
export function challengeSigningInput(challenge: Pick<KeyChallenge, 'nonce'>, purpose: ChallengePurpose, audience: string): Buffer {
  return Buffer.from(`spinajs-key-${purpose}:${challenge.nonce}:${audience}`, 'utf8');
}

/** The answer a client sends: the raw signature (64 bytes; ES256 as IEEE P1363) as unpadded base64url. */
export function signChallenge(challenge: Pick<KeyChallenge, 'nonce'>, purpose: ChallengePurpose, audience: string, privateKey: KeyObject, alg: KeyAlgorithm): string {
  return encodeB64url(signRaw(alg, privateKey, challengeSigningInput(challenge, purpose, audience)));
}

export function verifyChallengeSignature(key: KeyMaterial, nonce: string, purpose: ChallengePurpose, audience: string, signature: unknown): boolean {
  const raw = decodeB64url(signature);
  return raw !== null && isChallengeNonce(nonce) && verifySignature(key, challengeSigningInput({ nonce }, purpose, audience), raw);
}
