import { Inject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AuthenticationStrategy, KeyRegistry } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, KeyAlgorithm, SignedRequest, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';
import { dummyVerify, verifySignature } from '../jwk/signature.js';
import { digestMatches, lowerCaseHeaders, signatureBase } from '../httpsig/base.js';
import { parseByteSequenceDictionary, parseSignatureInput } from '../httpsig/fields.js';
import type { SignatureInput } from '../httpsig/fields.js';
import { KeyNonceStore, nonceKey } from '../nonce/store.js';
import { keysOptionsOf } from '../options/options.js';
import type { KeysConfig, KeysOptions } from '../options/options.js';
import { MAX_CREDENTIAL_LENGTH, failure, keySuccess, keyThrottleKeys, usableKey } from './keys.js';

/** RFC 9421 algorithm names; the `alg` parameter is optional and, when sent, must name the key's algorithm. */
const ALG_PARAM: Readonly<Record<string, KeyAlgorithm>> = { ed25519: 'EdDSA', 'ecdsa-p256-sha256': 'ES256' };
const PARAMS = ['created', 'expires', 'nonce', 'keyid', 'alg'];
const MAX_NONCE = 256;
const EMPTY = Buffer.alloc(0);

interface Checked {
  readonly input: SignatureInput;
  readonly signature: Buffer;
  readonly kid: string;
  readonly nonce: string;
  readonly expires: number;
  readonly alg?: KeyAlgorithm;
}

const isRequest = (r: unknown): r is SignedRequest => {
  const o = r as Record<string, unknown> | null;
  return typeof o === 'object' && o !== null && typeof o.method === 'string' && typeof o.targetUri === 'string' && typeof o.headers === 'object' && o.headers !== null && (o.body === undefined || o.body instanceof Uint8Array);
};

/**
 * Per-request HTTP message signatures, an RFC 9421 subset (design §22.10, A18): one signature; `@method`,
 * `@target-uri` and, with a body, `content-digest` (RFC 9530, checked against the body) covered; `created`, `expires`
 * at most `maxAgeSeconds` after it, a single-use `nonce` and `keyid`; `alg` optional. Any label is accepted.
 */
@Injectable(AuthenticationStrategy)
@Inject(KeyRegistry, KeyNonceStore)
export class HttpSignatureStrategy extends AuthenticationStrategy {
  readonly name = 'keys-httpsig';
  readonly kinds = ['http-signature'];
  readonly interactive = false;
  @Config('authn.keys')
  protected KeysConfig: KeysConfig;

  constructor(protected readonly registry: KeyRegistry, protected readonly nonces: KeyNonceStore, protected readonly Options?: KeysOptions) {
    super();
  }

  protected get options(): KeysOptions {
    return this.Options ?? keysOptionsOf(this.KeysConfig);
  }

  /** The signature work an unknown, revoked or expired key costs, so it answers in the time a known key does (A02). */
  protected unknownKeyWork(alg: KeyAlgorithm, data: Uint8Array, signature: Uint8Array): void {
    dummyVerify(alg, data, signature);
  }

  throttleKeys(c: Credentials, ctx: AuthnContext): readonly ThrottleKey[] {
    const req = c.kind === 'http-signature' && isRequest(c.request) ? c.request : null;
    const input = req ? lowerCaseHeaders(req.headers)['signature-input'] : undefined;
    const keyid = typeof input === 'string' && input.length <= MAX_CREDENTIAL_LENGTH ? parseSignatureInput(input)?.params.get('keyid') : undefined;
    return keyThrottleKeys(typeof keyid === 'string' ? keyid : null, ctx);
  }

  /** Everything that needs no key: the headers' form, the parameters, coverage, the digest and the time window. */
  protected check(req: SignedRequest, ctx: AuthnContext): Checked | null {
    const headers = lowerCaseHeaders(req.headers);
    if ([headers['signature-input'], headers.signature].some((v) => typeof v !== 'string' || v.length > MAX_CREDENTIAL_LENGTH)) {
      return null;
    }
    const input = parseSignatureInput(headers['signature-input']);
    const signatures = parseByteSequenceDictionary(headers.signature);
    if (!input || !signatures || signatures.size !== 1 || !signatures.has(input.label)) {
      return null;
    }
    const p = input.params;
    const created = p.get('created');
    const expires = p.get('expires');
    const nonce = p.get('nonce');
    const kid = p.get('keyid');
    const alg = p.get('alg');
    if ([...p.keys()].some((k) => !PARAMS.includes(k)) || typeof created !== 'number' || typeof expires !== 'number' || typeof nonce !== 'string' || nonce.length === 0 || nonce.length > MAX_NONCE || typeof kid !== 'string') {
      return null;
    }
    if (alg !== undefined && (typeof alg !== 'string' || !Object.hasOwn(ALG_PARAM, alg))) {
      return null;
    }

    const covered = new Set(input.components);
    const hasBody = req.body !== undefined;
    const required = this.options.httpSignature.requiredComponents.filter((c) => c !== 'content-digest' || hasBody);
    if (!covered.has('@method') || !covered.has('@target-uri') || (hasBody && !covered.has('content-digest')) || required.some((c) => !covered.has(c))) {
      return null;
    }
    if (covered.has('content-digest') && !digestMatches(headers['content-digest'], req.body ?? EMPTY)) {
      return null;
    }

    const h = this.options.httpSignature;
    const nowS = Math.floor(ctx.now.getTime() / 1000);
    if (created > nowS + h.skewSeconds || expires <= created || expires - created > h.maxAgeSeconds || nowS >= expires) {
      return null;
    }
    return { input, signature: signatures.get(input.label)!, kid, nonce, expires, ...(alg !== undefined ? { alg: ALG_PARAM[alg as string] } : {}) };
  }

  async verify(c: Credentials, ctx: AuthnContext): Promise<StrategyOutcome> {
    if (c.kind !== 'http-signature') {
      return failure('unsupported_credentials');
    }
    if (!isRequest(c.request)) {
      return failure('invalid_credentials');
    }
    const req = c.request;
    const checked = this.check(req, ctx);
    const base = checked ? signatureBase(req, checked.input) : null;
    if (!checked || base === null) {
      return failure('invalid_credentials');
    }
    const data = Buffer.from(base, 'utf8');
    const found = await usableKey(this.registry, checked.kid, ctx);
    if (!found.key) {
      this.unknownKeyWork(found.alg ?? checked.alg ?? 'EdDSA', data, checked.signature);
      return failure(found.reason);
    }
    const key = found.key;
    if ((checked.alg !== undefined && checked.alg !== key.alg) || !verifySignature(key, data, checked.signature)) {
      return failure('invalid_credentials');
    }
    const expiresAt = new Date((checked.expires + this.options.httpSignature.skewSeconds) * 1000);
    if (!(await this.nonces.claim(nonceKey('sig', key.kid, checked.nonce), expiresAt, ctx.now))) {
      return failure('invalid_credentials');
    }
    return keySuccess(this.registry, key, 'http-signature', ctx);
  }
}
