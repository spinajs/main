import { createHash, createPublicKey } from 'node:crypto';
import type { JsonWebKey as NodeJwk } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { AuthenticationStrategy } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, ExternalSubject, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';
import { createLocalJWKSet, createRemoteJWKSet, customFetch, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import type { FetchImplementation, JWK, JWTVerifyGetKey } from 'jose';

/** One item of `authn.jwt.issuers` (design §22.5). Exactly one of `jwksUri` and `keys`. */
export interface JwtIssuerConfig {
  issuer: string;
  audience: string;
  jwksUri?: string;
  keys?: JWK[];
  algorithms: string[];
  /** Integer 0–60, default 30. */
  clockSkewSeconds?: number;
  /** Default `sub`. */
  subjectClaim?: string;
  /** Default `jwt:<issuer>`; the IdentityLink provider. */
  provider?: string;
  /**
   * JIT provisioning of an unlinked subject needs this and `authn.linking.jit` (K6); default off. There is no
   * `byVerifiedEmail`: a bearer JWT never links by its email.
   */
  linking?: { jit?: boolean };
}

/** An issuer item after the schema: its defaults are filled in. */
type ConfiguredIssuer = JwtIssuerConfig & Required<Pick<JwtIssuerConfig, 'clockSkewSeconds' | 'subjectClaim'>>;

interface Issuer {
  readonly issuer: string;
  readonly audience: string;
  readonly algorithms: readonly string[];
  readonly clockSkewSeconds: number;
  readonly subjectClaim: string;
  readonly provider: string;
  readonly jit: boolean;
  readonly keys: JWTVerifyGetKey;
}

export const MAX_JWT_LENGTH = 8192;
const JWT_FORMAT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
/** authn_identity column widths. */
const MAX_PROVIDER = 128;
const MAX_SUBJECT = 255;
const MAX_EMAIL = 255;
const CLIENT_ASSERTION_TYP = 'spinajs-client+jwt';

/** Design §22.9: an unknown `kid` refreshes the JWKS at most once a minute. */
const JWKS_REFRESH_MS = 60_000;
/** jose re-fetches on every request once the set is older than this, so it must not be below the refresh limit. */
const JWKS_MAX_AGE_MS = 600_000;
const JWKS_TIMEOUT_MS = 5_000;

/** The curve jose's JWKS lookup requires for each EC/OKP algorithm (jose 6 selects only Ed25519 for EdDSA). */
const ALGORITHM_CURVES: Readonly<Record<string, string>> = { ES256: 'P-256', ES384: 'P-384', ES512: 'P-521', EdDSA: 'Ed25519' };
const MIN_RSA_BITS = 2048;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const codeOf = (err: unknown): unknown => (err as { code?: unknown } | null)?.code;

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || (isIPv4(hostname) && hostname.startsWith('127.'));
}

/**
 * jose counts its cooldown from the last good fetch only, so while the JWKS host is failing it would fetch on
 * every request. This fetch hook refuses to fetch again within the refresh limit after a failed fetch; jose
 * keeps answering from its cached set while that is fresh. Only the fetch itself starts the window: a member
 * that fails to import is chosen by the caller's `kid` and must not hold back the refresh of a rotated key.
 */
function remoteKeys(url: URL, onFetchFailure: (err: unknown) => void): JWTVerifyGetKey {
  let failedAt = Number.NEGATIVE_INFINITY;
  const failed = (err: unknown): never => {
    failedAt = Date.now();
    onFetchFailure(err);
    throw err;
  };

  const fetchJwks: FetchImplementation = async (href, init) => {
    if (Date.now() < failedAt + JWKS_REFRESH_MS) {
      throw new Error('JWKS fetch skipped after a recent failure');
    }
    let response: Response;
    try {
      response = await fetch(href, init);
    } catch (err) {
      return failed(err);
    }
    if (response.status !== 200) {
      return failed(new Error(`JWKS answered HTTP ${response.status}`));
    }
    let body: string;
    let json: unknown;
    try {
      body = await response.text();
      json = JSON.parse(body);
    } catch (err) {
      return failed(err);
    }
    if (!isPlainObject(json) || !Array.isArray(json.keys) || !json.keys.every(isPlainObject)) {
      return failed(new Error('JWKS body is not a JSON Web Key Set'));
    }
    return new Response(body, { status: 200 });
  };

  return createRemoteJWKSet(url, { cooldownDuration: JWKS_REFRESH_MS, cacheMaxAge: JWKS_MAX_AGE_MS, timeoutDuration: JWKS_TIMEOUT_MS, [customFetch]: fetchJwks });
}

/** True when jose's JWKS lookup can select a key of this type and curve for `alg`. */
function algorithmFits(alg: string, kty: unknown, crv: unknown): boolean {
  if (alg.startsWith('RS') || alg.startsWith('PS')) {
    return kty === 'RSA';
  }
  return kty === (alg === 'EdDSA' ? 'OKP' : 'EC') && crv === ALGORITHM_CURVES[alg];
}

/** A typ compares case-insensitively and may omit `application/` (RFC 7515 §4.1.9). */
function isClientAssertionTyp(typ: unknown): boolean {
  if (typeof typ !== 'string') {
    return false;
  }
  const t = typ.toLowerCase();
  return (t.startsWith('application/') ? t.slice('application/'.length) : t) === CLIENT_ASSERTION_TYP;
}

/**
 * Optional JWT bearer from configured issuers (design §22.9, A16). Answers the token's subject as an external
 * subject; AuthnService maps it through IdentityLinkStore (and JIT). Shares the `bearer` kind with TokenStrategy,
 * so a value outside the JWT format is `unsupported_credentials` without any I/O and the dispatch passes it on.
 */
@Injectable(AuthenticationStrategy)
export class JwtBearerStrategy extends AuthenticationStrategy {
  public readonly name = 'jwt';
  public readonly kinds: readonly string[] = ['bearer'];
  public readonly interactive = false;

  @Config('authn.jwt.issuers')
  protected Issuers: ConfiguredIssuer[];

  @Logger('authn-token')
  protected Log: Log;

  protected issuers = new Map<string, Issuer>();

  /** Fails boot on an issuer the schema cannot judge; builds one key resolver per issuer and keeps it, so its JWKS cache lives. */
  public async resolve(): Promise<void> {
    if (!this.Issuers) throw new InvalidOperation('authn.jwt.issuers is unset: AUTHN_CONFIGURATION_SCHEMA is not registered');
    const issuers = new Map<string, Issuer>();
    const providers = new Set<string>();
    this.Issuers.forEach((item, i) => {
      const at = `authn.jwt.issuers[${i}]`;
      const issuer = this.issuerOf(item, at);
      // A shared provider would let one issuer claim the subjects, and so the links, of another. The schema cannot
      // judge it: a derived provider is not in the config, and uniqueItemProperties counts a missing provider as a value.
      if (providers.has(issuer.provider)) {
        throw new Error(`${at}: provider ${issuer.provider} is used by another issuer`);
      }
      if (issuers.has(issuer.issuer)) {
        throw new Error(`${at}: issuer ${issuer.issuer} is configured twice`);
      }
      issuers.set(issuer.issuer, issuer);
      providers.add(issuer.provider);
    });
    this.issuers = issuers;
  }

  protected issuerOf(o: ConfiguredIssuer, at: string): Issuer {
    // The schema is the gate; this floor holds for values that never went through it (jose skips the aud check without an audience).
    if (typeof o.audience !== 'string' || o.audience.length === 0) {
      throw new Error(`${at}.audience must be a non-empty string`);
    }
    if (!(Number.isInteger(o.clockSkewSeconds) && o.clockSkewSeconds >= 0 && o.clockSkewSeconds <= 60)) {
      throw new Error(`${at}.clockSkewSeconds must be an integer from 0 to 60`);
    }
    const provider = o.provider ?? `jwt:${o.issuer}`;
    // The schema bounds an explicit provider; a derived one is the issuer plus a prefix.
    if (provider.length > MAX_PROVIDER) {
      throw new Error(`${at}.provider must be at most ${MAX_PROVIDER} characters`);
    }
    const algorithms = [...o.algorithms];
    const keys = o.jwksUri !== undefined ? this.remoteOf(o.jwksUri, o.issuer, at) : createLocalJWKSet({ keys: this.publicKeysOf(o.keys ?? [], algorithms, at) });
    return { issuer: o.issuer, audience: o.audience, algorithms, clockSkewSeconds: o.clockSkewSeconds, subjectClaim: o.subjectClaim, provider, jit: o.linking?.jit === true, keys };
  }

  protected remoteOf(jwksUri: string, issuer: string, at: string): JWTVerifyGetKey {
    let url: URL;
    try {
      url = new URL(jwksUri);
    } catch {
      throw new Error(`${at}.jwksUri must be a URL`);
    }
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname)))) {
      throw new Error(`${at}.jwksUri must use https (http only for a loopback host)`);
    }
    return remoteKeys(url, (err) => this.Log.warn(`Could not fetch the JWKS of JWT issuer ${issuer}: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Refuses a key jose would never select or verify with, so a config error does not look like an attack. The schema has judged the member shapes. */
  protected publicKeysOf(keys: JWK[], algorithms: readonly string[], at: string): JWK[] {
    return keys.map((key, j) => {
      const atKey = `${at}.keys[${j}]`;
      let modulusLength: number | undefined;
      try {
        modulusLength = createPublicKey({ key: key as NodeJwk, format: 'jwk' }).asymmetricKeyDetails?.modulusLength;
      } catch {
        throw new Error(`${atKey} is not a valid public JWK`);
      }
      if (key.kty === 'RSA' && !((modulusLength ?? 0) >= MIN_RSA_BITS)) {
        throw new Error(`${atKey} is an RSA key under ${MIN_RSA_BITS} bits`);
      }
      const candidates = key.alg !== undefined ? [key.alg] : algorithms;
      if (!candidates.some((alg) => algorithmFits(alg, key.kty, key.crv))) {
        throw new Error(`${atKey} fits none of the issuer's algorithms`);
      }
      return { ...key };
    });
  }

  /** N1's CredentialSelector hook: true only for a bearer value in the JWT format while issuers are configured. */
  public accepts(c: Credentials): boolean {
    return this.tokenOf(c) !== null;
  }

  /** Reads the credential once, as TokenStrategy does; a hostile object reads as "not ours". */
  protected tokenOf(c: Credentials): string | null {
    try {
      if (this.issuers.size === 0 || typeof c !== 'object' || c === null || c.kind !== 'bearer') {
        return null;
      }
      const token: unknown = (c as { token?: unknown }).token;
      if (typeof token !== 'string' || token.length > MAX_JWT_LENGTH || !JWT_FORMAT.test(token)) {
        return null;
      }
      return token;
    } catch {
      return null;
    }
  }

  /** @spinajs/authn's ExternalLinkingStrategy: JIT only for an issuer whose `linking.jit` is on; never by email. */
  public linkingFor(external: ExternalSubject): { jit: boolean; byVerifiedEmail: boolean } {
    const issuer = [...this.issuers.values()].find((i) => i.provider === external?.provider);
    return { jit: issuer?.jit === true, byVerifiedEmail: false };
  }

  /** From a hash of the token, never its claims: a forged `iss`/`sub` must not make a victim's key back off. */
  public throttleKeys(c: Credentials, ctx: AuthnContext): readonly ThrottleKey[] {
    const token = this.tokenOf(c);
    if (token === null) {
      return [];
    }

    const id = `jwt:${createHash('sha256').update(`authn-jwt-throttle:${token}`).digest('hex').slice(0, 32)}`;
    return [
      { kind: 'account', value: id },
      { kind: 'account-ip', value: `${id}|${ctx?.ip ?? ''}` },
    ];
  }

  public async verify(c: Credentials, ctx: AuthnContext): Promise<StrategyOutcome> {
    const token = this.tokenOf(c);
    if (token === null) {
      return { ok: false, reason: 'unsupported_credentials' };
    }

    try {
      // Checked here so the strategy fails closed whatever the jose version does with an invalid currentDate.
      const now: number = Date.prototype.getTime.call(ctx.now);
      if (!Number.isFinite(now)) {
        return { ok: false, reason: 'invalid_credentials' };
      }

      const iss = decodeJwt(token).iss;
      const issuer = typeof iss === 'string' ? this.issuers.get(iss) : undefined;
      if (!issuer) {
        return { ok: false, reason: 'invalid_credentials' };
      }
      // Client assertions belong to authn-keys; one must never pass as a bearer.
      if (isClientAssertionTyp(decodeProtectedHeader(token).typ)) {
        return { ok: false, reason: 'invalid_credentials' };
      }

      const { payload } = await jwtVerify(token, issuer.keys, {
        issuer: issuer.issuer,
        audience: issuer.audience,
        algorithms: [...issuer.algorithms],
        clockTolerance: issuer.clockSkewSeconds,
        currentDate: new Date(now),
        requiredClaims: ['exp'],
      });

      const subject = Object.hasOwn(payload, issuer.subjectClaim) ? payload[issuer.subjectClaim] : undefined;
      if (typeof subject !== 'string' || subject.length === 0 || subject.length > MAX_SUBJECT) {
        return { ok: false, reason: 'invalid_credentials' };
      }

      // Never emailVerified: a bearer JWT must not link to an account by its email.
      const email = payload.email;
      const external: ExternalSubject = {
        provider: issuer.provider,
        subject,
        ...(typeof email === 'string' && email.length <= MAX_EMAIL ? { email } : {}),
        claims: payload,
      };
      return { ok: true, external, method: 'jwt' };
    } catch (err) {
      return { ok: false, reason: codeOf(err) === 'ERR_JWT_EXPIRED' ? 'expired' : 'invalid_credentials' };
    }
  }
}
