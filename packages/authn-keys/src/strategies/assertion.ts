import { Autoinject, Injectable } from '@spinajs/di';
import { AuthenticationStrategy, JwsVerifier } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnFailure, Credentials, JwsClaims, KeyAlgorithm, KeyRecord, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';
import { _is_string, _max_length, _try_check_arg, isPlainObject } from '@spinajs/util';
import { InvalidOption } from '@spinajs/exceptions';
import { decodeB64url } from '../jwk/base64url.js';
import { KEY_ALGORITHMS } from '../jwk/keys.js';
import { parseStrictJson } from '../jws/json.js';
import { KeyNonceStore, nonceKey } from '../nonce/store.js';
import { KeyStrategy, MAX_CREDENTIAL_LENGTH, assertionIssuer, failure, keyThrottleKeys, usableKey } from './keys.js';
import type { KeyStrategyDeps } from './keys.js';

const MAX_JTI = 128;

interface AssertionClaims extends JwsClaims {
  readonly jti: string;
}

const assertionClaims = (p: Readonly<Record<string, unknown>>): AssertionClaims | null => (typeof p.jti === 'string' && p.jti.length > 0 && p.jti.length <= MAX_JTI ? (p as unknown as AssertionClaims) : null);

function headerOf(jws: unknown): { kid: string | null; alg: KeyAlgorithm } {
  const text = typeof jws === 'string' && jws.length <= MAX_CREDENTIAL_LENGTH ? jws.slice(0, jws.indexOf('.')) : '';
  const bytes = decodeB64url(text);
  const h = bytes ? parseStrictJson(bytes) : undefined;
  const alg = isPlainObject(h) && KEY_ALGORITHMS.includes(h.alg as KeyAlgorithm) ? (h.alg as KeyAlgorithm) : 'EdDSA';
  return { kid: isPlainObject(h) && typeof h.kid === 'string' ? h.kid : null, alg };
}

export interface JwsAssertionStrategyDeps extends KeyStrategyDeps {
  readonly verifier?: JwsVerifier;
  readonly nonces?: KeyNonceStore;
}

/**
 * Machine clients: `Authorization: Bearer <jws>` signed by a registered key (design §22.10, A17). Header typ
 * `authn.keys.assertion.typ`; claims iss = the key owner as `<type>:<id>`, aud = `authn.keys.assertion.audience`,
 * iat, exp (lifetime at most 300 s) and a jti accepted once within its lifetime.
 */
@Injectable(AuthenticationStrategy)
export class JwsAssertionStrategy extends KeyStrategy<JwsAssertionStrategyDeps> {
  readonly name = 'keys-jws';
  readonly kinds = ['jws-assertion'];
  readonly interactive = false;

  @Autoinject(JwsVerifier)
  protected Verifier: JwsVerifier;

  @Autoinject(KeyNonceStore)
  protected Nonces: KeyNonceStore;

  protected get verifier(): JwsVerifier {
    return this.Deps?.verifier ?? this.Verifier;
  }

  protected get nonces(): KeyNonceStore {
    return this.Deps?.nonces ?? this.Nonces;
  }

  /** The audience the assertions name; which strategies are listed decides that one is required, so this is a boot check, not a schema rule. */
  protected get audience(): string {
    const audience = this.options.assertion.audience;
    if (audience === null) {
      throw new InvalidOption('authn.keys.assertion.audience must be set to accept JWS assertions');
    }
    return audience;
  }

  public async resolve(): Promise<void> {
    void this.audience;
    await super.resolve();
  }

  throttleKeys(c: Credentials, ctx: AuthnContext): readonly ThrottleKey[] {
    return keyThrottleKeys(c.kind === 'jws-assertion' ? headerOf(c.jws).kid : null, ctx);
  }

  async verify(c: Credentials, ctx: AuthnContext): Promise<StrategyOutcome> {
    if (c.kind !== 'jws-assertion') {
      return failure('unsupported_credentials');
    }
    const [ok, jws] = _try_check_arg(_is_string(_max_length(MAX_CREDENTIAL_LENGTH)))(c.jws, 'jws');
    if (!ok) {
      return failure('invalid_credentials');
    }
    const a = this.options.assertion;
    let unusable: AuthnFailure = 'invalid_credentials';
    const r = await this.verifier.verify<AssertionClaims, KeyRecord>(jws, {
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
        const [h, p, s] = jws.split('.');
        this.unknownKeyWork(headerOf(jws).alg, Buffer.from(`${h}.${p}`, 'ascii'), decodeB64url(s) ?? Buffer.alloc(0));
        return failure(unusable);
      }
      return failure('invalid_credentials');
    }
    if (!(await this.nonces.claim(nonceKey('jti', r.key.kid, r.claims.jti), new Date((r.claims.exp + a.skewSeconds) * 1000), ctx.now))) {
      return failure('invalid_credentials');
    }
    return this.success(r.key, 'jws', ctx);
  }
}
