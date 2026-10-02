import { createPublicKey, verify } from 'node:crypto';
import { JwsSigner, JwsVerifier } from '@spinajs/authn/contracts';
import type { JwsClaims, JwsErrorCode, JwsHeader, JwsKey, JwsSignOptions, JwsVerification, JwsVerifyOptions } from '@spinajs/authn/contracts';
import type { KitKeyPair } from '../../src/harness/index.js';
import { signCompactJws } from '../../src/helpers/index.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SECOND = 1000;

const fail = (code: JwsErrorCode): { ok: false; code: JwsErrorCode } => ({ ok: false, code });

function parseJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function signatureHolds(key: JwsKey, input: string, signature: Buffer): boolean {
  try {
    const publicKey = createPublicKey({ key: key.jwk as never, format: 'jwk' });
    return key.alg === 'EdDSA' ? verify(null, Buffer.from(input), publicKey, signature) : verify('sha256', Buffer.from(input), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}

/** The check order of JwsVerifier's contract, in about 60 lines: the kit's reference for A17/jws. */
export class ReferenceJwsVerifier extends JwsVerifier {
  async verify<C extends JwsClaims, K extends JwsKey = JwsKey>(token: string, opts: JwsVerifyOptions<C, K>): Promise<JwsVerification<C, K>> {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((p) => BASE64URL.test(p) && p.length % 4 !== 1)) {
      return fail('malformed');
    }
    const [headerPart, payloadPart, signaturePart] = parts;
    const signature = Buffer.from(signaturePart, 'base64url');
    const header = parseJson(headerPart);
    const payload = parseJson(payloadPart);
    if (signature.length !== 64 || !header || !payload) {
      return fail('malformed');
    }

    const names = Object.keys(header).sort();
    if (names.join() !== 'alg,kid,typ' || typeof header.kid !== 'string' || header.typ !== opts.typ || !(opts.algorithms as readonly unknown[]).includes(header.alg)) {
      return fail('bad_header');
    }

    const key = await opts.keys(header.kid);
    if (!key || key.alg !== header.alg) {
      return fail('unknown_key');
    }
    if (!signatureHolds(key, `${headerPart}.${payloadPart}`, signature)) {
      return fail('bad_signature');
    }

    const { iss, aud, iat, exp } = payload;
    const claims = typeof iss === 'string' && typeof aud === 'string' && Number.isInteger(iat) && Number.isInteger(exp) ? opts.claims(payload) : null;
    if (!claims || (exp as number) <= (iat as number) || (exp as number) - (iat as number) > opts.maxLifetimeSeconds) {
      return fail('invalid_claims');
    }
    if (typeof opts.issuer === 'string' ? iss !== opts.issuer : !opts.issuer(iss as string, key)) {
      return fail('wrong_issuer');
    }
    if (aud !== opts.audience) {
      return fail('wrong_audience');
    }
    const nowS = Math.floor(opts.now.getTime() / SECOND);
    if (nowS >= (exp as number) + opts.skewSeconds) {
      return fail('expired');
    }
    if ((iat as number) > nowS + opts.skewSeconds) {
      return fail('not_yet_valid');
    }
    return { ok: true, header: header as unknown as JwsHeader, claims, key };
  }
}

/** Signs with the first key by default; header { alg, kid, typ } in that order, payload as JSON.stringify writes it. */
export class ReferenceJwsSigner extends JwsSigner {
  constructor(private readonly pairs: readonly KitKeyPair[]) {
    super();
  }

  async sign<C extends JwsClaims>(claims: C, opts: JwsSignOptions): Promise<string> {
    const pair = opts.kid === undefined ? this.pairs[0] : this.pairs.find((p) => p.kid === opts.kid);
    if (!pair) {
      throw new Error(`no key ${opts.kid}`);
    }
    return signCompactJws({ alg: pair.alg, kid: pair.kid, typ: opts.typ }, claims as unknown as Record<string, unknown>, pair);
  }

  async publicKeys(): Promise<readonly JwsKey[]> {
    return this.pairs.map((p) => ({ alg: p.alg, jwk: p.publicJwk, kid: p.kid } as JwsKey));
  }
}
