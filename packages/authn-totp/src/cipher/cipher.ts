import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { identityKey } from '../store/identity.js';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const HEX = /^[0-9a-fA-F]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]{43}=?$/;
const BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const PART = /^[A-Za-z0-9_-]+$/;

/** An `authn.mfa.encryptionKey` key and its id, which rows store next to the cipher text. */
export interface MfaKey {
  /** Not enumerable, so it stays out of logs and JSON. */
  readonly key: Buffer;
  /** The first 16 chars of base64url(SHA-256(key)). */
  readonly keyId: string;
}

/** A 32-byte key given as 64 hex chars, base64 (44, or 43 unpadded) or base64url (43); anything else throws `InvalidOption` without the value. */
export function mfaKeyFrom(secret: string): MfaKey {
  let key: Buffer | undefined;
  if (typeof secret === 'string') {
    if (HEX.test(secret)) {
      key = Buffer.from(secret, 'hex');
    } else if (BASE64.test(secret) || BASE64URL.test(secret)) {
      key = Buffer.from(secret, 'base64');
      // Unused low bits in the last character would let several texts name one key.
      if (key.toString('base64url') !== secret.replace(/=$/, '').replace(/\+/g, '-').replace(/\//g, '_')) {
        key = undefined;
      }
    }
  }
  if (!key || key.length !== KEY_BYTES) {
    throw new InvalidOption('authn.mfa.encryptionKey: a key must be 32 bytes given as 64 hex characters, base64 or base64url');
  }
  const result = { keyId: createHash('sha256').update(key).digest('base64url').slice(0, 16) } as { key: Buffer; keyId: string };
  Object.defineProperty(result, 'key', { value: key, enumerable: false });
  return Object.freeze(result);
}

function aad(identity: IdentityRef | string, step: string): Buffer {
  const id = typeof identity === 'string' ? identity : identityKey(identity);
  if (typeof id !== 'string' || id.length === 0) {
    throw new InvalidArgument('MFA cipher: identity must be a non-empty string');
  }
  // Without "|" in the step, the last "|" splits the AAD into exactly one (identity, step) pair.
  if (typeof step !== 'string' || step.length === 0 || step.includes('|')) {
    throw new InvalidArgument('MFA cipher: step must be a non-empty string without "|"');
  }
  return Buffer.from(`${id}|${step}`, 'utf8');
}

/** Test vectors only: a fixed IV under one key breaks GCM. */
export function encryptMfaSecretWithIv(key: MfaKey, identity: IdentityRef | string, step: string, plain: string, iv: Buffer): string {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new InvalidArgument('MFA cipher: the secret must be a non-empty string');
  }
  if (!Buffer.isBuffer(iv) || iv.length !== IV_BYTES) {
    throw new InvalidArgument('MFA cipher: the IV must be 12 bytes');
  }
  const cipher = createCipheriv(ALGORITHM, key.key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(identity, step));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/** AES-256-GCM with AAD `${identity}|${step}`; returns `v1.<iv>.<tag>.<ct>`, each part base64url. */
export function encryptMfaSecret(key: MfaKey, identity: IdentityRef | string, step: string, plain: string): string {
  return encryptMfaSecretWithIv(key, identity, step, plain, randomBytes(IV_BYTES));
}

/** Throws `InvalidArgument` on a malformed text, an unknown version, another key, a changed text or another row's identity or step. */
export function decryptMfaSecret(key: MfaKey, identity: IdentityRef | string, step: string, enc: string): string {
  const ad = aad(identity, step);
  const parts = typeof enc === 'string' ? enc.split('.') : [];
  if (parts.length !== 4 || parts[0] !== VERSION || !parts.slice(1).every((p) => PART.test(p))) {
    throw new InvalidArgument('MFA cipher: the cipher text is not of the form v1.<iv>.<tag>.<ct>');
  }
  const [iv, tag, ct] = parts.slice(1).map((p) => Buffer.from(p, 'base64url'));
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new InvalidArgument('MFA cipher: the cipher text has a wrong IV or tag length');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key.key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(ad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new InvalidArgument('MFA cipher: the cipher text does not decrypt under this key for this identity and step');
  }
}
