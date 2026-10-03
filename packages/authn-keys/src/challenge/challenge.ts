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
  return RID.test(rid) ? { rid, nonce: id.slice(RID_LENGTH + 1) } : null;
}

/** The bytes a key signs to answer a challenge: UTF-8 of `spinajs-key-<purpose>:<nonce>` (the purpose separates domains). */
export function challengeSigningInput(challenge: Pick<KeyChallenge, 'nonce'>, purpose: ChallengePurpose): Buffer {
  return Buffer.from(`spinajs-key-${purpose}:${challenge.nonce}`, 'utf8');
}

/** The answer a client sends: the raw signature (64 bytes; ES256 as IEEE P1363) as unpadded base64url. */
export function signChallenge(challenge: Pick<KeyChallenge, 'nonce'>, purpose: ChallengePurpose, privateKey: KeyObject, alg: KeyAlgorithm): string {
  return encodeB64url(signRaw(alg, privateKey, challengeSigningInput(challenge, purpose)));
}

export function verifyChallengeSignature(key: KeyMaterial, nonce: string, purpose: ChallengePurpose, signature: unknown): boolean {
  const raw = decodeB64url(signature);
  return raw !== null && verifySignature(key, challengeSigningInput({ nonce }, purpose), raw);
}
