import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { JwsSigner } from '@spinajs/authn/contracts';
import type { JwsClaims, JwsKey, JwsSignOptions } from '@spinajs/authn/contracts';
import { decodeB64url, encodeB64url } from '../jwk/base64url.js';
import { checkPublicJwk, isValidKid } from '../jwk/keys.js';
import { signRaw } from '../jwk/signature.js';
import { parseStrictJson } from './json.js';

/** A private signing JWK: Ed25519 (RFC 8037) or P-256, with its `kid`. */
export interface PrivateJwk {
  readonly kty: string;
  readonly crv: string;
  readonly kid: string;
  readonly x: string;
  readonly y?: string;
  readonly d: string;
}

interface SigningKey {
  readonly publicKey: JwsKey;
  readonly privateKey: KeyObject;
}

const isUint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function signingKey(jwk: PrivateJwk): SigningKey {
  const where = `signing key ${JSON.stringify(jwk?.kid)}`;
  if (!isValidKid(jwk?.kid)) {
    throw new Error(`${where}: kid must be 1-64 of [A-Za-z0-9._-]`);
  }
  const material = checkPublicJwk(jwk.kty === 'EC' ? { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } : { kty: jwk.kty, crv: jwk.crv, x: jwk.x });
  if (!material) {
    throw new Error(`${where}: not a valid Ed25519 or P-256 key`);
  }
  if (decodeB64url(jwk.d)?.length !== 32) {
    throw new Error(`${where}: d must be 32 bytes of base64url`);
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: { ...material.jwk, d: jwk.d }, format: 'jwk' });
  } catch {
    throw new Error(`${where}: the private key does not load`);
  }
  const derived = createPublicKey(privateKey).export({ format: 'jwk' });
  if (derived.x !== material.jwk.x || (material.jwk.kty === 'EC' && derived.y !== material.jwk.y)) {
    throw new Error(`${where}: the public part does not match d`);
  }
  return { publicKey: Object.freeze({ ...material, kid: jwk.kid }) as JwsKey, privateKey };
}

/**
 * JwsSigner over private JWKs the app loads (from a secret reference) and passes in; the first key, or `current`,
 * signs by default. Header and claims are written exactly as canvas C8 does, so EdDSA tickets come out byte for byte.
 */
export class LocalJwsSigner extends JwsSigner {
  private readonly keys = new Map<string, SigningKey>();
  private readonly current: string;

  constructor(privateJwks: readonly PrivateJwk[], opts: { readonly current?: string } = {}) {
    super();
    for (const jwk of privateJwks) {
      if (this.keys.has(jwk.kid)) {
        throw new Error(`signing key ${JSON.stringify(jwk.kid)} appears twice`);
      }
      this.keys.set(jwk.kid, signingKey(jwk));
    }
    const current = opts.current ?? privateJwks[0]?.kid;
    if (current === undefined || !this.keys.has(current)) {
      throw new Error(`no signing key ${JSON.stringify(current)}`);
    }
    this.current = current;
  }

  async sign<C extends JwsClaims>(claims: C, opts: JwsSignOptions): Promise<string> {
    const kid = opts.kid ?? this.current;
    const key = this.keys.get(kid);
    if (!key) {
      throw new Error(`no signing key ${JSON.stringify(kid)}`);
    }
    if (typeof opts.typ !== 'string' || opts.typ.length === 0) {
      throw new Error('a JWS needs a typ');
    }
    if (typeof claims.iss !== 'string' || typeof claims.aud !== 'string' || !isUint(claims.iat) || !isUint(claims.exp) || claims.exp <= claims.iat) {
      throw new Error('claims need string iss and aud, and integer iat < exp in Unix seconds');
    }
    const header = JSON.stringify({ alg: key.publicKey.alg, kid, typ: opts.typ });
    const payload = JSON.stringify(claims);
    if (parseStrictJson(Buffer.from(payload, 'utf8'), ['iat', 'exp']) === undefined) {
      throw new Error('claims must be JSON a strict verifier reads (no lone surrogates, no nesting deeper than 127)');
    }
    const input = `${encodeB64url(header)}.${encodeB64url(payload)}`;
    return `${input}.${encodeB64url(signRaw(key.publicKey.alg, key.privateKey, Buffer.from(input, 'ascii')))}`;
  }

  async publicKeys(): Promise<readonly JwsKey[]> {
    return Object.freeze([...this.keys.values()].map((k) => k.publicKey));
  }
}
