import { createHash, createPublicKey } from 'node:crypto';
import type { JsonWebKey as NodeJwk } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
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
}

interface Issuer {
  readonly issuer: string;
  readonly audience: string;
  readonly algorithms: readonly string[];
  readonly clockSkewSeconds: number;
  readonly subjectClaim: string;
  readonly provider: string;
  readonly keys: JWTVerifyGetKey;
}

export const MAX_JWT_LENGTH = 8192;
const JWT_FORMAT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const ALGORITHMS = new Set(['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']);
const MEMBERS = new Set(['issuer', 'audience', 'jwksUri', 'keys', 'algorithms', 'clockSkewSeconds', 'subjectClaim', 'provider']);
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];
const KEY_TYPES = new Set(['RSA', 'EC', 'OKP']);
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
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
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

  @Config('authn.jwt.issuers', { defaultValue: [] })
  protected Issuers: unknown;

  @Logger('authn-token')
  protected Log: Log;

  protected issuers = new Map<string, Issuer>();

  /** Fails boot on any invalid issuer; builds one key resolver per issuer and keeps it, so its JWKS cache lives. */
  public async resolve(): Promise<void> {
    const raw = this.Issuers ?? [];
    if (!Array.isArray(raw)) {
      throw new Error('authn.jwt.issuers must be an array');
    }

    const issuers = new Map<string, Issuer>();
    const providers = new Set<string>();
    raw.forEach((item: unknown, i: number) => {
      const at = `authn.jwt.issuers[${i}]`;
      const issuer = this.issuerOf(item, at);
      if (issuers.has(issuer.issuer)) {
        throw new Error(`${at}: issuer ${issuer.issuer} is configured twice`);
      }
      // A shared provider would let one issuer claim the subjects, and so the links, of another.
      if (providers.has(issuer.provider)) {
        throw new Error(`${at}: provider ${issuer.provider} is used by another issuer`);
      }
      issuers.set(issuer.issuer, issuer);
      providers.add(issuer.provider);
    });
    this.issuers = issuers;
  }

  protected issuerOf(item: unknown, at: string): Issuer {
    if (!isPlainObject(item)) {
      throw new Error(`${at} must be an object`);
    }
    const set = Object.entries(item).filter(([, v]) => v !== undefined);
    const unknown = set.map(([k]) => k).filter((k) => !MEMBERS.has(k));
    if (unknown.length > 0) {
      throw new Error(`${at} has unknown members: ${unknown.join(', ')}`);
    }
    const o: Record<string, unknown> = Object.fromEntries(set);

    if (!isNonEmptyString(o.issuer)) {
      throw new Error(`${at}.issuer must be a non-empty string`);
    }
    if (!isNonEmptyString(o.audience)) {
      throw new Error(`${at}.audience must be a non-empty string`);
    }
    if ((o.jwksUri === undefined) === (o.keys === undefined)) {
      throw new Error(`${at} needs exactly one of jwksUri and keys`);
    }
    const algorithms = o.algorithms;
    if (!Array.isArray(algorithms) || algorithms.length === 0 || !algorithms.every((a: unknown) => typeof a === 'string' && ALGORITHMS.has(a))) {
      throw new Error(`${at}.algorithms must be a non-empty subset of ${[...ALGORITHMS].join(' ')}`);
    }
    const clockSkewSeconds = o.clockSkewSeconds ?? 30;
    if (typeof clockSkewSeconds !== 'number' || !Number.isInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 60) {
      throw new Error(`${at}.clockSkewSeconds must be an integer from 0 to 60`);
    }
    const subjectClaim = o.subjectClaim ?? 'sub';
    if (!isNonEmptyString(subjectClaim)) {
      throw new Error(`${at}.subjectClaim must be a non-empty string`);
    }
    const provider = o.provider ?? `jwt:${o.issuer}`;
    if (!isNonEmptyString(provider) || provider.length > MAX_PROVIDER) {
      throw new Error(`${at}.provider must be a non-empty string of at most ${MAX_PROVIDER} characters`);
    }

    const allowed = [...(algorithms as string[])];
    const keys = o.jwksUri !== undefined ? this.remoteOf(o.jwksUri, o.issuer, at) : createLocalJWKSet({ keys: this.publicKeysOf(o.keys, allowed, at) });

    return { issuer: o.issuer, audience: o.audience, algorithms: allowed, clockSkewSeconds, subjectClaim, provider, keys };
  }

  protected remoteOf(jwksUri: unknown, issuer: string, at: string): JWTVerifyGetKey {
    let url: URL | null = null;
    try {
      url = typeof jwksUri === 'string' ? new URL(jwksUri) : null;
    } catch {
      url = null;
    }
    if (url === null) {
      throw new Error(`${at}.jwksUri must be a URL`);
    }
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname)))) {
      throw new Error(`${at}.jwksUri must use https (http only for a loopback host)`);
    }
    return remoteKeys(url, (err) => this.Log.warn(`Could not fetch the JWKS of JWT issuer ${issuer}: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Refuses any key jose would never select or verify with, so a config error does not look like an attack. */
  protected publicKeysOf(keys: unknown, algorithms: readonly string[], at: string): JWK[] {
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error(`${at}.keys must be a non-empty array of public JWKs`);
    }
    return keys.map((key: unknown, j: number) => {
      const atKey = `${at}.keys[${j}]`;
      if (!isPlainObject(key) || !KEY_TYPES.has(key.kty as string)) {
        throw new Error(`${atKey} must be an RSA, EC or OKP public JWK`);
      }
      if (PRIVATE_JWK_MEMBERS.some((m) => m in key)) {
        throw new Error(`${atKey} holds private key material`);
      }
      let modulusLength: number | undefined;
      try {
        modulusLength = createPublicKey({ key: key as NodeJwk, format: 'jwk' }).asymmetricKeyDetails?.modulusLength;
      } catch {
        throw new Error(`${atKey} is not a valid public JWK`);
      }
      if (key.kty === 'RSA' && !((modulusLength ?? 0) >= MIN_RSA_BITS)) {
        throw new Error(`${atKey} is an RSA key under ${MIN_RSA_BITS} bits`);
      }
      if (key.use !== undefined && key.use !== 'sig') {
        throw new Error(`${atKey}.use must be sig`);
      }
      const ops = key.key_ops;
      if (ops !== undefined && !(Array.isArray(ops) && ops.every((op) => typeof op === 'string') && new Set(ops).size === ops.length && ops.includes('verify'))) {
        throw new Error(`${atKey}.key_ops must be distinct strings that include verify`);
      }
      if (key.ext !== undefined && typeof key.ext !== 'boolean') {
        throw new Error(`${atKey}.ext must be a boolean`);
      }
      if (key.alg !== undefined && !algorithms.includes(key.alg as string)) {
        throw new Error(`${atKey}.alg is not one of the issuer's algorithms`);
      }
      const candidates = key.alg !== undefined ? [key.alg as string] : algorithms;
      if (!candidates.some((alg) => algorithmFits(alg, key.kty, key.crv))) {
        throw new Error(`${atKey} fits none of the issuer's algorithms`);
      }
      return { ...key } as JWK;
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
