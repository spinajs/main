import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { KeyAlgorithm, KeyMaterial } from '@spinajs/authn/contracts';
import { isSmallOrder } from './ed25519.js';
import { publicKeyObject } from './keys.js';

/** Raw signature length for both algorithms: Ed25519, and ES256 as IEEE P1363 r || s. */
export const SIGNATURE_BYTES = 64;

function verifyWith(alg: KeyAlgorithm, key: KeyObject, data: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== SIGNATURE_BYTES) {
    return false;
  }
  try {
    if (alg === 'EdDSA') {
      // ed25519-dalek's verify_strict refuses a small-order R and OpenSSL does not; canvas C8 refuses it on both sides.
      return !isSmallOrder(signature.subarray(0, 32)) && verify(null, data, key, signature);
    }
    return verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}

/** Verifies with the key's own algorithm; false for a key that fails the key checks or any other signature length. */
export function verifySignature(material: KeyMaterial, data: Uint8Array, signature: Uint8Array): boolean {
  const key = publicKeyObject(material);
  return key !== null && verifyWith(material.alg, key, data, signature);
}

/** Raw signature: Ed25519, or ES256 over SHA-256 as IEEE P1363. */
export function signRaw(alg: KeyAlgorithm, privateKey: KeyObject, data: Uint8Array): Buffer {
  return alg === 'EdDSA' ? sign(null, data, privateKey) : sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
}

const dummies: Record<KeyAlgorithm, KeyObject> = {
  EdDSA: createPublicKey(generateKeyPairSync('ed25519').privateKey),
  ES256: createPublicKey(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey),
};

/** The work of one verification under a key nobody holds, so an unknown key costs what a known one does (A02). */
export function dummyVerify(alg: KeyAlgorithm, data: Uint8Array, signature: Uint8Array): false {
  verifyWith(alg, dummies[alg], data, signature.length === SIGNATURE_BYTES ? signature : Buffer.alloc(SIGNATURE_BYTES, 1));
  return false;
}
