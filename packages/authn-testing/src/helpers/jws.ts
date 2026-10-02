import { createHmac, sign } from 'node:crypto';
import { b64url } from './crypto.js';
import type { KitKeyPair } from '../harness/index.js';

/** Key 'none' gives an empty signature; { hmacKey } signs HS256. ES256 signatures are 64-byte ieee-p1363. */
export function signCompactJws(header: Record<string, unknown>, payload: Record<string, unknown> | string, key: KitKeyPair | 'none' | { hmacKey: Uint8Array }): string {
  const input = `${b64url(JSON.stringify(header))}.${b64url(typeof payload === 'string' ? payload : JSON.stringify(payload))}`;
  let signature: Buffer;
  if (key === 'none') {
    signature = Buffer.alloc(0);
  } else if ('hmacKey' in key) {
    signature = createHmac('sha256', key.hmacKey).update(input).digest();
  } else if (key.alg === 'EdDSA') {
    signature = sign(null, Buffer.from(input), key.privateKey);
  } else {
    signature = sign('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  }
  return `${input}.${b64url(signature)}`;
}

export function compactJws(parts: readonly [string, string, string]): string {
  return parts.join('.');
}
