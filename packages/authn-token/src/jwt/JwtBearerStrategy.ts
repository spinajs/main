import { createHash, createPublicKey } from 'node:crypto';
import type { JsonWebKey as NodeJwk } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { AuthenticationStrategy } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, ExternalSubject, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';
import { createLocalJWKSet, createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import type { JWK, JWTVerifyGetKey } from 'jose';

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

const KEY_LOOKUP_CODES = new Set(['ERR_JWKS_NO_MATCHING_KEY', 'ERR_JWKS_MULTIPLE_MATCHING_KEYS', 'ERR_JOSE_NOT_SUPPORTED']);

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const codeOf = (err: unknown): unknown => (err as { code?: unknown } | null)?.code;

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || (isIPv4(hostname) && hostname.startsWith('127.'));
}

/**
 * jose counts its cooldown from the last good fetch only, so while the JWKS host is failing it would fetch on
 * every request. After a failure this answers from the cached set (while still fresh) and does not fetch again
 * within the refresh limit.
 */
function remoteKeys(url: URL, onFetchFailure: (err: unknown) => void): JWTVerifyGetKey {
  const remote = createRemoteJWKSet(url, { cooldownDuration: JWKS_REFRESH_MS, cacheMaxAge: JWKS_MAX_AGE_MS, timeoutDuration: JWKS_TIMEOUT_MS });
  let failedAt = Number.NEGATIVE_INFINITY;

  return async (header, token) => {
    if (Date.now() < failedAt + JWKS_REFRESH_MS) {
      const cached = remote.jwks();
      if (!cached || !remote.fresh) {
        throw new Error('JWKS unavailable');
      }
      return createLocalJWKSet(cached)(header, token);
    }
    try {
      return await remote(header, token);
    } catch (err) {
      if (!KEY_LOOKUP_CODES.has(codeOf(err) as string)) {
        failedAt = Date.now();
        onFetchFailure(err);
      }
      throw err;
    }
  };
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

    const keys = o.jwksUri !== undefined ? this.remoteOf(o.jwksUri, o.issuer, at) : createLocalJWKSet({ keys: this.publicKeysOf(o.keys, at) });

    return { issuer: o.issuer, audience: o.audience, algorithms: [...(algorithms as string[])], clockSkewSeconds, subjectClaim, provider, keys };
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

  protected publicKeysOf(keys: unknown, at: string): JWK[] {
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error(`${at}.keys must be a non-empty array of public JWKs`);
    }
    return keys.map((key: unknown, j: number) => {
      if (!isPlainObject(key) || !KEY_TYPES.has(key.kty as string)) {
        throw new Error(`${at}.keys[${j}] must be an RSA, EC or OKP public JWK`);
      }
      if (PRIVATE_JWK_MEMBERS.some((m) => m in key)) {
        throw new Error(`${at}.keys[${j}] holds private key material`);
      }
      try {
        createPublicKey({ key: key as NodeJwk, format: 'jwk' });
      } catch {
        throw new Error(`${at}.keys[${j}] is not a valid public JWK`);
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
        currentDate: ctx.now,
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
