import AjvModule from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { InvalidOption } from '@spinajs/exceptions';

import { OIDC_SIGNING_ALGORITHMS } from '../contracts.js';
import type { OidcAppPath, OidcAuthorizationParams, OidcClaimPath, OidcClaimsMapping, OidcEndpoints, OidcPresetId, OidcProviderSource, OidcSecretRef, OidcSigningAlgorithm, OidcStrategyName, OidcTokenEndpointAuth } from '../contracts.js';
import { DEFAULT_CLAIMS, OIDC_PRESETS, resolveEndpoints, resolveIssuer } from '../presets.js';
import { checkedUrl, deepFreeze, isPlainObject, isRelaxedEnv } from '../support.js';
import { AUTHN_OIDC_PROVIDER_SCHEMA, OIDC_APP_PATH_PATTERN, OIDC_PROVIDER_NAME_PATTERN } from './schema.js';

const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new (opts?: object) => { compile(schema: object): ValidateFunction };

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

export interface ReadOidcOptionsExtra {
  /** The global authn.linking switches; a provider switch without its global one only earns a warning. */
  readonly linking?: { readonly jit: boolean; readonly byVerifiedEmail: boolean };
  readonly log?: { warn(message: string): void };
}

const ROOT = 'authn.oidc';
const SOURCE_KEYS = ['preset', 'issuer', 'tenant', 'baseUrl', 'realm', 'domain', 'authorizationServer', 'host'] as const;
/** nOAuth: claims a user or a tenant admin can change, so they never identify an account. */
const MUTABLE_SUBJECT_CLAIMS = new Set(['email', 'upn', 'preferred_username', 'login', 'name']);

let validateProvider: ValidateFunction | undefined;

const fail = (message: string): never => {
  throw new InvalidOption(message);
};

/** Members set to undefined count as absent (config files and spreads leave them behind). */
function withoutUndefined(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutUndefined);
  if (!isPlainObject(v)) return v;
  return Object.fromEntries(
    Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => [k, withoutUndefined(x)]),
  );
}

/** Paths and keywords only: AJV is not in verbose mode, so no value (and no secret) reaches the message. */
function describe(e: ErrorObject): string {
  const path = e.instancePath.split('/').filter(Boolean).join('.');
  const params = e.params as Record<string, unknown>;
  const extra = (params.additionalProperty ?? params.missingProperty ?? params.propertyName) as string | undefined;
  const at = [path, extra].filter(Boolean).join('.');
  return `${at || '(provider)'} ${e.message ?? e.keyword}`;
}

function checkProviderShape(at: string, raw: Record<string, unknown>): void {
  validateProvider ??= new Ajv({ strict: true, strictRequired: false, allowUnionTypes: true, allErrors: true }).compile(AUTHN_OIDC_PROVIDER_SCHEMA);
  if (validateProvider(raw)) return;
  const errors = (validateProvider.errors ?? []).filter((e) => e.keyword !== 'if');
  fail(`${at}: ${[...new Set(errors.map(describe))].join('; ')}`);
}

const lastSegment = (p: OidcClaimPath): string => (typeof p === 'string' ? p : p[p.length - 1]);

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

function checkFinite(at: string, required: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(required)) {
    if (typeof v === 'number' && !Number.isFinite(v)) {
      fail(`${at}.requiredClaims.${k} must be a finite number`);
    }
  }
}

function sourceOf(raw: Record<string, unknown>): OidcProviderSource {
  return Object.fromEntries(SOURCE_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]])) as unknown as OidcProviderSource;
}

function readProvider(name: string, input: unknown, env: string | undefined, extra: ReadOidcOptionsExtra): OidcProviderOptions {
  const at = `${ROOT}.providers.${name}`;
  if (!isPlainObject(input)) {
    return fail(`${at} must be an object`);
  }
  const raw = withoutUndefined(input) as Record<string, unknown>;
  checkProviderShape(at, raw);
  const relaxed = isRelaxedEnv(env);
  checkUrls(at, raw, relaxed);
  checkFinite(at, (raw.requiredClaims ?? {}) as Record<string, unknown>);

  const source = sourceOf(raw);
  const presetId = (raw.preset as OidcPresetId | undefined) ?? null;
  const preset = presetId ? OIDC_PRESETS[presetId] : null;
  const idToken = preset ? preset.idToken : true;

  const claims: OidcClaimsMapping = { ...(preset?.claims ?? DEFAULT_CLAIMS), ...((raw.claims ?? {}) as Partial<OidcClaimsMapping>) };
  if (MUTABLE_SUBJECT_CLAIMS.has(lastSegment(claims.subject).toLowerCase())) {
    fail(`${at}.claims.subject must be an immutable subject, never email, upn, preferred_username, login or name`);
  }

  const configuredScopes = (raw.scopes as string[] | undefined) ?? preset?.scopes ?? ['openid', 'email', 'profile'];
  const scopes = idToken && !configuredScopes.includes('openid') ? ['openid', ...configuredScopes] : [...configuredScopes];

  const linking = { jit: false, byVerifiedEmail: false, ...((raw.linking ?? {}) as { jit?: boolean; byVerifiedEmail?: boolean }) };
  if (extra.linking && extra.log) {
    for (const k of ['jit', 'byVerifiedEmail'] as const) {
      if (linking[k] && !extra.linking[k]) {
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
    clientId: raw.clientId as string,
    clientSecret: { secret: (raw.clientSecret as OidcSecretRef).secret },
    tokenEndpointAuth: (raw.tokenEndpointAuth as OidcTokenEndpointAuth | undefined) ?? preset?.tokenEndpointAuth ?? 'client_secret_basic',
    redirectUri: (raw.redirectUri as string | undefined) ?? null,
    scopes,
    claims,
    algorithms: [...((raw.algorithms as OidcSigningAlgorithm[] | undefined) ?? OIDC_SIGNING_ALGORITHMS)],
    clockSkewSeconds: (raw.clockSkewSeconds as number | undefined) ?? 30,
    // The subject of a plain OAuth2 provider comes from userinfo, so it is always on.
    userinfo: idToken ? ((raw.userinfo as boolean | undefined) ?? 'auto') : true,
    requiredClaims: { ...((raw.requiredClaims ?? {}) as Record<string, string | number | boolean>) },
    authorizationParams: { ...((raw.authorizationParams ?? {}) as Record<string, string>) } as OidcAuthorizationParams,
    linking,
  });
}

const APP_PATH = new RegExp(OIDC_APP_PATH_PATTERN);
const PROVIDER_NAME = new RegExp(OIDC_PROVIDER_NAME_PATTERN);

function readRedirects(raw: unknown): OidcOptions['redirects'] {
  if (raw === undefined) return { success: '/', failure: '/' };
  if (!isPlainObject(raw)) return fail(`${ROOT}.redirects must be an object`);
  const out: Record<string, OidcAppPath> = { success: '/', failure: '/' };
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (k !== 'success' && k !== 'failure') fail(`${ROOT}.redirects: unknown key ${JSON.stringify(k)}`);
    if (typeof v !== 'string' || !APP_PATH.test(v)) fail(`${ROOT}.redirects.${k} must be an app-relative path: one leading '/', never '//' or '/\\'`);
    out[k] = v as OidcAppPath;
  }
  return out as OidcOptions['redirects'];
}

/**
 * `authn.oidc` after the schema, the boot checks (design §22.15: names, subject mapping, Entra tenant, redirects,
 * https outside development and test) and the defaults. Throws InvalidOption naming the provider and the key; a message
 * never carries a configured value.
 */
export function readOidcOptions(raw: unknown, env: string | undefined, extra: ReadOidcOptionsExtra = {}): OidcOptions {
  const input = raw === undefined || raw === null ? {} : raw;
  if (!isPlainObject(input)) {
    return fail(`${ROOT} must be an object`);
  }
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined && k !== 'providers' && k !== 'redirects') fail(`${ROOT}: unknown key ${JSON.stringify(k)}`);
  }
  const rawProviders = input.providers ?? {};
  if (!isPlainObject(rawProviders)) {
    return fail(`${ROOT}.providers must be an object of providers by name`);
  }
  const providers = new Map<string, OidcProviderOptions>();
  for (const [name, provider] of Object.entries(rawProviders)) {
    if (provider === undefined) continue;
    if (!PROVIDER_NAME.test(name)) {
      fail(`${ROOT}.providers: the provider name ${JSON.stringify(name)} must be 1–59 of [a-z0-9_-]`);
    }
    providers.set(name, readProvider(name, provider, env, extra));
  }
  return Object.freeze({ providers, redirects: Object.freeze(readRedirects(input.redirects)) });
}
