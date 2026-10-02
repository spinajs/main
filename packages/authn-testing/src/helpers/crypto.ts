import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { KeyAlgorithm, PublicJwk } from '@spinajs/authn/contracts';
import type { KitKeyPair } from '../harness/index.js';

export function b64url(data: Uint8Array | string): string {
  return Buffer.from(data as string).toString('base64url');
}

export function b64urlDecode(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) {
    throw new RangeError('not unpadded base64url');
  }
  return Buffer.from(s, 'base64url');
}

export function sha256hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256b64(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('base64');
}

/** RFC 7638: required members only, in lexicographic order. */
export function thumbprint(jwk: PublicJwk): string {
  const json = jwk.kty === 'OKP' ? `{"crv":"${jwk.crv}","kty":"OKP","x":"${jwk.x}"}` : `{"crv":"${jwk.crv}","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
  return createHash('sha256').update(json).digest('base64url');
}

export function generateKeyPair(alg: KeyAlgorithm): KitKeyPair {
  const pair = alg === 'EdDSA' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = createPublicKey(pair.privateKey).export({ format: 'jwk' });
  const publicJwk: PublicJwk = alg === 'EdDSA' ? { kty: 'OKP', crv: 'Ed25519', x: jwk.x as string } : { kty: 'EC', crv: 'P-256', x: jwk.x as string, y: jwk.y as string };
  return { alg, publicJwk, privateKey: pair.privateKey, kid: thumbprint(publicJwk) };
}
