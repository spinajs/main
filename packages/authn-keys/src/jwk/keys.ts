import { createHash, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { Ed25519PublicJwk, KeyAlgorithm, KeyMaterial, P256PublicJwk, PublicJwk } from '@spinajs/authn/contracts';
import { decodeB64url } from './base64url.js';
import { isCanonicalPoint, isSmallOrder } from './ed25519.js';

export const KEY_ALGORITHMS: readonly KeyAlgorithm[] = Object.freeze(['EdDSA', 'ES256']);

const KID = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidKid(kid: unknown): kid is string {
  return typeof kid === 'string' && KID.test(kid);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const has32Bytes = (v: unknown): v is string => decodeB64url(v)?.length === 32;

function importable(jwk: PublicJwk): KeyObject | null {
  try {
    return createPublicKey({ key: { ...jwk }, format: 'jwk' });
  } catch {
    return null;
  }
}

/**
 * Design §22.10, canvas C8 D5: an Ed25519 key (RFC 8037) whose `x` is a canonical point and not of small order, or a
 * P-256 key whose `x` and `y` are 32 bytes and on the curve; never a private part. Members other than the required ones
 * are dropped, never trusted (the algorithm comes from the key type). Null for anything else.
 */
export function checkPublicJwk(input: unknown, allowed: readonly KeyAlgorithm[] = KEY_ALGORITHMS): KeyMaterial | null {
  if (!isPlainObject(input) || 'd' in input) {
    return null;
  }
  let material: KeyMaterial | null = null;
  if (input.kty === 'OKP' && input.crv === 'Ed25519' && has32Bytes(input.x)) {
    const x = decodeB64url(input.x)!;
    if (isCanonicalPoint(x) && !isSmallOrder(x)) {
      const jwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: input.x };
      material = { alg: 'EdDSA', jwk };
    }
  } else if (input.kty === 'EC' && input.crv === 'P-256' && has32Bytes(input.x) && has32Bytes(input.y)) {
    const jwk: P256PublicJwk = { kty: 'EC', crv: 'P-256', x: input.x, y: input.y };
    material = { alg: 'ES256', jwk };
  }
  if (!material || !allowed.includes(material.alg) || !importable(material.jwk)) {
    return null;
  }
  return material;
}

/** RFC 7638: the required members only, in lexicographic order, no whitespace; SHA-256, base64url. */
export function thumbprint(jwk: PublicJwk): string {
  const json = jwk.kty === 'OKP' ? JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }) : JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash('sha256').update(json, 'utf8').digest('base64url');
}

const CACHE_LIMIT = 1024;
const checked = new Map<string, KeyObject>();

function cacheKey(m: KeyMaterial): string | null {
  const jwk = m.jwk as unknown as Record<string, unknown>;
  if ('d' in jwk || typeof jwk.x !== 'string') {
    return null;
  }
  if (m.alg === 'EdDSA' && jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
    return `EdDSA:${jwk.x}`;
  }
  if (m.alg === 'ES256' && jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.y === 'string') {
    return `ES256:${jwk.x}:${jwk.y}`;
  }
  return null;
}

/**
 * The node:crypto key for a material that passes checkPublicJwk with its own algorithm, or null. Materials can come
 * from a caller's key lookup, so they are checked again here (cached, as the point check costs a few modular powers).
 */
export function publicKeyObject(material: KeyMaterial): KeyObject | null {
  if (!isPlainObject(material) || !isPlainObject(material.jwk)) {
    return null;
  }
  const key = cacheKey(material);
  if (key === null) {
    return null;
  }
  const hit = checked.get(key);
  if (hit) {
    return hit;
  }
  const ok = checkPublicJwk(material.jwk);
  if (!ok || ok.alg !== material.alg) {
    return null;
  }
  const object = importable(ok.jwk);
  if (!object) {
    return null;
  }
  if (checked.size >= CACHE_LIMIT) {
    checked.delete(checked.keys().next().value as string);
  }
  checked.set(key, object);
  return object;
}
