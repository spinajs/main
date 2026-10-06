import { Inject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AuthenticationStrategy, JwsVerifier, KeyRegistry } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnFailure, Credentials, JwsClaims, KeyAlgorithm, KeyRecord, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';
import { decodeB64url } from '../jwk/base64url.js';
import { KEY_ALGORITHMS } from '../jwk/keys.js';
import { dummyVerify } from '../jwk/signature.js';
import { isJsonObject, parseStrictJson } from '../jws/json.js';
import { KeyNonceStore, nonceKey } from '../nonce/store.js';
import { keysOptionsOf } from '../options/options.js';
import type { KeysConfig, KeysOptions } from '../options/options.js';
import { MAX_CREDENTIAL_LENGTH, assertionIssuer, failure, keySuccess, keyThrottleKeys, usableKey } from './keys.js';

const MAX_JTI = 128;

interface AssertionClaims extends JwsClaims {
  readonly jti: string;
}

const assertionClaims = (p: Readonly<Record<string, unknown>>): AssertionClaims | null => (typeof p.jti === 'string' && p.jti.length > 0 && p.jti.length <= MAX_JTI ? (p as unknown as AssertionClaims) : null);

function headerOf(jws: unknown): { kid: string | null; alg: KeyAlgorithm } {
  const text = typeof jws === 'string' && jws.length <= MAX_CREDENTIAL_LENGTH ? jws.slice(0, jws.indexOf('.')) : '';
  const bytes = decodeB64url(text);
  const h = bytes ? parseStrictJson(bytes) : undefined;
  const alg = isJsonObject(h) && KEY_ALGORITHMS.includes(h.alg as KeyAlgorithm) ? (h.alg as KeyAlgorithm) : 'EdDSA';
  return { kid: isJsonObject(h) && typeof h.kid === 'string' ? h.kid : null, alg };
}

/**
 * Machine clients: `Authorization: Bearer <jws>` signed by a registered key (design §22.10, A17). Header typ
 * `authn.keys.assertion.typ`; claims iss = the key owner as `<type>:<id>`, aud = `authn.keys.assertion.audience`,
 * iat, exp (lifetime at most 300 s) and a jti accepted once within its lifetime.
 */
@Injectable(AuthenticationStrategy)
@Inject(KeyRegistry, JwsVerifier, KeyNonceStore)
export class JwsAssertionStrategy extends AuthenticationStrategy {
  readonly name = 'keys-jws';
  readonly kinds = ['jws-assertion'];
  readonly interactive = false;
  @Config('authn.keys')
  protected KeysConfig: KeysConfig;

  constructor(protected readonly registry: KeyRegistry, protected readonly verifier: JwsVerifier, protected readonly nonces: KeyNonceStore, protected readonly Options?: KeysOptions) {
    super();
  }

  protected get options(): KeysOptions {
    return this.Options ?? keysOptionsOf(this.KeysConfig);
  }

  /** The audience the assertions name; which strategies are listed decides that one is required, so this is a boot check, not a schema rule. */
  protected get audience(): string {
    const audience = this.options.assertion.audience;
    if (audience === null) {
      throw new Error('authn.keys.assertion.audience must be set to accept JWS assertions');
    }
    return audience;
  }

  public async resolve(): Promise<void> {
    void this.audience;
    await super.resolve();
  }

  /** The signature work an unknown, revoked or expired key costs, so it answers in the time a known key does (A02). */
  protected unknownKeyWork(alg: KeyAlgorithm, data: Uint8Array, signature: Uint8Array): void {
    dummyVerify(alg, data, signature);
  }

  throttleKeys(c: Credentials, ctx: AuthnContext): readonly ThrottleKey[] {
    return keyThrottleKeys(c.kind === 'jws-assertion' ? headerOf(c.jws).kid : null, ctx);
  }

  async verify(c: Credentials, ctx: AuthnContext): Promise<StrategyOutcome> {
    if (c.kind !== 'jws-assertion') {
      return failure('unsupported_credentials');
    }
    if (typeof c.jws !== 'string' || c.jws.length > MAX_CREDENTIAL_LENGTH) {
      return failure('invalid_credentials');
    }
    const a = this.options.assertion;
    let unusable: AuthnFailure = 'invalid_credentials';
    const r = await this.verifier.verify<AssertionClaims, KeyRecord>(c.jws, {
      typ: a.typ,
      algorithms: this.options.algorithms,
      keys: async (kid) => {
        const found = await usableKey(this.registry, kid, ctx);
        if (!found.key) {
          unusable = found.reason;
          return null;
        }
        return found.key;
      },
      claims: assertionClaims,
      issuer: (iss, key) => iss === assertionIssuer(key.owner),
      audience: this.audience,
      now: ctx.now,
      skewSeconds: a.skewSeconds,
      maxLifetimeSeconds: a.maxLifetimeSeconds,
    });
    if (!r.ok) {
      if (r.code === 'unknown_key') {
        const [h, p, s] = c.jws.split('.');
        this.unknownKeyWork(headerOf(c.jws).alg, Buffer.from(`${h}.${p}`, 'ascii'), decodeB64url(s) ?? Buffer.alloc(0));
        return failure(unusable);
      }
      return failure('invalid_credentials');
    }
    if (!(await this.nonces.claim(nonceKey('jti', r.key.kid, r.claims.jti), new Date((r.claims.exp + a.skewSeconds) * 1000), ctx.now))) {
      return failure('invalid_credentials');
    }
    return keySuccess(this.registry, r.key, 'jws', ctx);
  }
}
