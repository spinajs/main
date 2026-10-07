import { InvalidOption } from '@spinajs/exceptions';

import type { OidcAppPath, OidcAuthorizationParams, OidcClaimPath, OidcClaimsMapping, OidcEndpoints, OidcPresetId, OidcProviderConfig, OidcProviderSource, OidcSecretRef, OidcSigningAlgorithm, OidcStrategyName, OidcTokenEndpointAuth } from '../contracts.js';
import { DEFAULT_CLAIMS, OIDC_PRESETS, resolveEndpoints, resolveIssuer } from '../presets.js';
import { checkedUrl, deepFreeze, isRelaxedEnv } from '../support.js';
import { OIDC_APP_PATH_PATTERN } from './schema.js';

/** One configured provider after defaults and presets; deep frozen. */
export interface OidcProviderOptions {
  readonly name: string;
  readonly strategy: OidcStrategyName;
  readonly preset: OidcPresetId | null;
  readonly source: OidcProviderSource;
  /** False for plain OAuth2 (GitHub): no ID token, no discovery. */
  readonly idToken: boolean;
  /** null for plain OAuth2. */
  readonly issuer: string | null;
  readonly issuerAliases: readonly string[];
  /** Fixed endpoints of plain OAuth2; null when discovery finds them. */
  readonly endpoints: OidcEndpoints | null;
  readonly clientId: string;
  readonly clientSecret: OidcSecretRef;
  readonly tokenEndpointAuth: OidcTokenEndpointAuth;
  /** null: the callback route on the request's origin. */
  readonly redirectUri: string | null;
  readonly scopes: readonly string[];
  readonly claims: OidcClaimsMapping;
  readonly algorithms: readonly OidcSigningAlgorithm[];
  readonly clockSkewSeconds: number;
  /** 'auto': fetch when the provider has a userinfo endpoint. */
  readonly userinfo: boolean | 'auto';
  readonly requiredClaims: Readonly<Record<string, string | number | boolean>>;
  readonly authorizationParams: OidcAuthorizationParams;
  readonly linking: { readonly jit: boolean; readonly byVerifiedEmail: boolean };
}

export interface OidcOptions {
  readonly providers: ReadonlyMap<string, OidcProviderOptions>;
  readonly redirects: { readonly success: OidcAppPath; readonly failure: OidcAppPath };
}

/** A provider as the schema leaves it: the defaults are filled in. */
export type ConfiguredProvider = OidcProviderConfig & {
  readonly clockSkewSeconds: number;
  readonly algorithms: readonly OidcSigningAlgorithm[];
  readonly requiredClaims: Readonly<Record<string, string | number | boolean>>;
  readonly authorizationParams: Readonly<Record<string, string>>;
  readonly linking: { readonly jit: boolean; readonly byVerifiedEmail: boolean };
};

/** `authn.oidc` as the schema validates and defaults it. */
export interface ConfiguredOidc {
  readonly providers: Readonly<Record<string, ConfiguredProvider>>;
  readonly redirects: { readonly success: OidcAppPath; readonly failure: OidcAppPath };
}

export interface BuildOidcOptionsExtra {
  /** The global authn.linking switches (default off); a provider switch without its global one only earns a warning. */
  readonly linking?: { readonly jit: boolean; readonly byVerifiedEmail: boolean };
  readonly log?: { warn(message: string): void };
}

const ROOT = 'authn.oidc';
const SOURCE_KEYS = ['preset', 'issuer', 'tenant', 'baseUrl', 'realm', 'domain', 'authorizationServer', 'host'] as const;
/** nOAuth: claims a user or a tenant admin can change, so they never identify an account. */
const MUTABLE_SUBJECT_CLAIMS = new Set(['email', 'upn', 'preferred_username', 'login', 'name']);
const APP_PATH = new RegExp(OIDC_APP_PATH_PATTERN);

/** The secret stays readable, but JSON and util.inspect show it redacted, so a dump of the options never leaks it. */
function redacted(secret: string): OidcSecretRef {
  const ref = { secret };
  const hidden = { secret: '[redacted]' };
  Object.defineProperty(ref, 'toJSON', { value: () => hidden, enumerable: false });
  Object.defineProperty(ref, Symbol.for('nodejs.util.inspect.custom'), { value: () => hidden, enumerable: false });
  return ref;
}

const fail = (message: string): never => {
  throw new InvalidOption(message);
};

const lastSegment = (p: OidcClaimPath): string => (typeof p === 'string' ? p : p[p.length - 1]);

/** Members a JS config file set to undefined count as absent, so they never override a preset or default. */
const defined = <T extends object>(o: T | undefined): Partial<T> => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

// What the schema cannot judge: the scheme rule depends on the app env, which it cannot read.
function checkUrls(at: string, raw: Record<string, unknown>, relaxed: boolean): void {
  const scheme = relaxed ? 'an http or https URL' : 'an https URL';
  if (raw.issuer !== undefined && !checkedUrl(raw.issuer, { relaxed })) {
    fail(`${at}.issuer must be ${scheme} without credentials, query or fragment`);
  }
  if (raw.baseUrl !== undefined && !checkedUrl(raw.baseUrl, { relaxed })) {
    fail(`${at}.baseUrl must be ${scheme} without credentials, query or fragment`);
  }
  if (raw.redirectUri !== undefined && !checkedUrl(raw.redirectUri, { relaxed, query: true })) {
    fail(`${at}.redirectUri must be an absolute ${relaxed ? 'http or https' : 'https'} URL without credentials or fragment`);
  }
}

function sourceOf(raw: Record<string, unknown>): OidcProviderSource {
  return Object.fromEntries(SOURCE_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]])) as unknown as OidcProviderSource;
}

function buildProvider(name: string, provider: ConfiguredProvider, env: string | undefined, extra: BuildOidcOptionsExtra): OidcProviderOptions {
  const at = `${ROOT}.providers.${name}`;
  const raw = provider as unknown as Record<string, unknown>;
  checkUrls(at, raw, isRelaxedEnv(env));

  // Floor (see buildOidcOptions): a missing, NaN, string or huge skew switches the exp, iat and nbf checks off.
  const skew = provider.clockSkewSeconds;
  if (!Number.isInteger(skew) || skew < 0 || skew > 300) fail(`${at}.clockSkewSeconds must be an integer from 0 to 300`);

  const source = sourceOf(raw);
  const presetId = provider.preset ?? null;
  const preset = presetId ? OIDC_PRESETS[presetId] : null;
  const idToken = preset ? preset.idToken : true;

  const claims: OidcClaimsMapping = { ...(preset?.claims ?? DEFAULT_CLAIMS), ...defined(provider.claims) };
  if (MUTABLE_SUBJECT_CLAIMS.has(lastSegment(claims.subject).toLowerCase())) {
    fail(`${at}.claims.subject must be an immutable subject, never email, upn, preferred_username, login or name`);
  }

  const configuredScopes = provider.scopes ?? preset?.scopes ?? ['openid', 'email', 'profile'];
  const scopes = idToken && !configuredScopes.includes('openid') ? ['openid', ...configuredScopes] : [...configuredScopes];

  // Floor (see buildOidcOptions): the strategy reads these switches as truthy, so only true may turn one on.
  const linking = { jit: provider.linking?.jit === true, byVerifiedEmail: provider.linking?.byVerifiedEmail === true };
  if (extra.log) {
    const global = extra.linking ?? { jit: false, byVerifiedEmail: false };
    for (const k of ['jit', 'byVerifiedEmail'] as const) {
      if (linking[k] && !global[k]) {
        extra.log.warn(`${at}.linking.${k} is on but authn.linking.${k} is off, so it has no effect`);
      }
    }
  }

  return deepFreeze({
    name,
    strategy: `oidc:${name}` as OidcStrategyName,
    preset: presetId,
    source,
    idToken,
    issuer: idToken ? resolveIssuer(source) : null,
    issuerAliases: preset?.issuerAliases ? [...preset.issuerAliases] : [],
    endpoints: idToken ? null : { ...resolveEndpoints(source) },
    clientId: provider.clientId,
    clientSecret: redacted(provider.clientSecret.secret),
    tokenEndpointAuth: provider.tokenEndpointAuth ?? preset?.tokenEndpointAuth ?? 'client_secret_basic',
    redirectUri: provider.redirectUri ?? null,
    scopes,
    claims,
    algorithms: [...provider.algorithms],
    clockSkewSeconds: skew,
    // The subject of a plain OAuth2 provider comes from userinfo, so it is always on.
    userinfo: idToken ? (provider.userinfo ?? 'auto') : true,
    requiredClaims: defined(provider.requiredClaims) as Record<string, string | number | boolean>,
    authorizationParams: defined(provider.authorizationParams) as OidcAuthorizationParams,
    linking,
  });
}

/**
 * The options of a validated `authn.oidc` (design §22.15): the preset merge, the https rule outside development and test,
 * the subject mapping and the linking warnings. The shape, the names, the redirects and the defaults are the schema's.
 * Throws InvalidOption naming the provider and the key; a message never carries a configured value.
 *
 * The floors below repeat a schema rule where a bad value would fail open, for a config the schema never saw: the
 * controller is found by a directory scan, so it can serve an app that never ran OidcBootstrapper.
 */
export function buildOidcOptions(config: ConfiguredOidc, env: string | undefined, extra: BuildOidcOptionsExtra = {}): OidcOptions {
  for (const k of ['success', 'failure'] as const) {
    const path: unknown = config.redirects?.[k];
    if (typeof path !== 'string' || !APP_PATH.test(path)) fail(`${ROOT}.redirects.${k} must be an app-relative path: one leading '/', never '//' or '/\\'`);
  }
  const providers = new Map(Object.entries(config.providers).map(([name, provider]) => [name, buildProvider(name, provider, env, extra)] as const));
  return Object.freeze({ providers, redirects: Object.freeze({ ...config.redirects }) });
}
