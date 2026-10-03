import { Injectable } from '@spinajs/di';
import { JwsVerifier } from '@spinajs/authn/contracts';
import type { JwsClaims, JwsErrorCode, JwsHeader, JwsKey, JwsVerification, JwsVerifyOptions, KeyAlgorithm } from '@spinajs/authn/contracts';
import { decodeB64url } from '../jwk/base64url.js';
import { publicKeyObject } from '../jwk/keys.js';
import { SIGNATURE_BYTES, verifySignature } from '../jwk/signature.js';
import { isJsonObject, parseStrictJson } from './json.js';

const HEADER_MEMBERS = ['alg', 'kid', 'typ'];

const fail = (code: JwsErrorCode): { readonly ok: false; readonly code: JwsErrorCode } => ({ ok: false, code });

const isUint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * Compact JWS under the canvas C8 D4 rules (lane notes D3): the first failing check gives the code. The signature is
 * checked with the key's own algorithm; a key that fails the key checks counts as unknown.
 */
@Injectable(JwsVerifier)
export class StrictJwsVerifier extends JwsVerifier {
  async verify<C extends JwsClaims, K extends JwsKey = JwsKey>(token: string, opts: JwsVerifyOptions<C, K>): Promise<JwsVerification<C, K>> {
    if (typeof token !== 'string') {
      return fail('malformed');
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
      return fail('malformed');
    }
    const [headerText, payloadText, signatureText] = parts;
    const headerBytes = decodeB64url(headerText);
    const payloadBytes = decodeB64url(payloadText);
    const signature = decodeB64url(signatureText);
    if (!headerBytes || !payloadBytes || signature?.length !== SIGNATURE_BYTES) {
      return fail('malformed');
    }

    const h = parseStrictJson(headerBytes);
    if (!isJsonObject(h) || Object.keys(h).length !== HEADER_MEMBERS.length || !HEADER_MEMBERS.every((m) => typeof h[m] === 'string')) {
      return fail('bad_header');
    }
    const header: JwsHeader = Object.freeze({ alg: h.alg as KeyAlgorithm, kid: h.kid as string, typ: h.typ as string });
    if (!opts.algorithms.includes(header.alg) || header.typ !== opts.typ) {
      return fail('bad_header');
    }

    const key = await opts.keys(header.kid);
    if (!key || key.alg !== header.alg || publicKeyObject(key) === null) {
      return fail('unknown_key');
    }
    if (!verifySignature(key, Buffer.from(`${headerText}.${payloadText}`, 'ascii'), signature)) {
      return fail('bad_signature');
    }

    const payload = parseStrictJson(payloadBytes, ['iat', 'exp']);
    if (!isJsonObject(payload)) {
      return fail('invalid_claims');
    }
    const { iss, aud, iat, exp } = payload;
    if (typeof iss !== 'string' || typeof aud !== 'string' || !isUint(iat) || !isUint(exp) || exp <= iat || exp - iat > opts.maxLifetimeSeconds) {
      return fail('invalid_claims');
    }
    const claims = opts.claims(payload);
    if (claims === null) {
      return fail('invalid_claims');
    }
    if (typeof opts.issuer === 'function' ? !opts.issuer(iss, key) : iss !== opts.issuer) {
      return fail('wrong_issuer');
    }
    if (aud !== opts.audience) {
      return fail('wrong_audience');
    }
    const nowS = Math.floor(opts.now.getTime() / 1000);
    if (nowS >= exp + opts.skewSeconds) {
      return fail('expired');
    }
    if (iat > nowS + opts.skewSeconds) {
      return fail('not_yet_valid');
    }
    return { ok: true, header, claims, key };
  }
}
