import { OIDC_PRESET_IDS, OIDC_SIGNING_ALGORITHMS } from '../contracts.js';
import type { OidcReservedParam } from '../contracts.js';

export const OIDC_RESERVED_PARAMS: readonly OidcReservedParam[] = Object.freeze(['response_type', 'response_mode', 'client_id', 'redirect_uri', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method', 'request', 'request_uri', 'max_age', 'acr_values'] satisfies OidcReservedParam[]);

export const OIDC_PROVIDER_NAME_PATTERN = '^[a-z0-9_-]{1,59}$';
/**
 * One leading '/', never '//' or '/\' (protocol-relative URLs), and no control character, space or backslash anywhere:
 * browsers drop tabs and newlines from a Location, so '/\t/evil.example' would become '//evil.example'.
 */
export const OIDC_APP_PATH_PATTERN = '^/(?![/\\\\])[^\\x00-\\x20\\x7f\\\\]*$';
export const OIDC_ENTRA_TENANT_PATTERN = '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$';
/** A host name with an optional port; no scheme, path, credentials or empty labels. */
export const OIDC_HOST_PATTERN = '^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?$';
/** A single path segment, never '.' or '..'. */
export const OIDC_SEGMENT_PATTERN = '^[A-Za-z0-9_-][A-Za-z0-9._-]*$';
/** RFC 6749 §3.3 scope-token. */
const SCOPE_TOKEN_PATTERN = '^[\\x21\\x23-\\x5B\\x5D-\\x7E]+$';

const SOURCE_KEYS = ['issuer', 'tenant', 'baseUrl', 'realm', 'domain', 'authorizationServer', 'host'] as const;

const claimPath = { anyOf: [{ type: 'string', minLength: 1 }, { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }] };
const optionalClaimPath = { anyOf: [...claimPath.anyOf, { type: 'null' }] };

/** The source keys a branch takes; every other source key is refused with a false schema, which names the key. */
function only(...allowed: (typeof SOURCE_KEYS)[number][]): Record<string, false> {
  return Object.fromEntries(SOURCE_KEYS.filter((k) => !allowed.includes(k)).map((k) => [k, false]));
}

const branch = (preset: string, then: Record<string, unknown>) => ({
  if: { type: 'object', properties: { preset: { const: preset } }, required: ['preset'] },
  then: { type: 'object', ...then },
});

/** One authn.oidc.providers.<name> entry (OidcProviderConfig). URL schemes, the subject rule and the env are checked by readOidcOptions. */
export const AUTHN_OIDC_PROVIDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['clientId', 'clientSecret'],
  properties: {
    preset: { type: 'string', enum: [...OIDC_PRESET_IDS] },
    issuer: { type: 'string', minLength: 1 },
    tenant: { type: 'string', pattern: OIDC_ENTRA_TENANT_PATTERN },
    baseUrl: { type: 'string', minLength: 1 },
    realm: { type: 'string', pattern: OIDC_SEGMENT_PATTERN },
    domain: { type: 'string', pattern: OIDC_HOST_PATTERN },
    authorizationServer: { anyOf: [{ type: 'string', pattern: OIDC_SEGMENT_PATTERN }, { type: 'null' }] },
    host: { type: 'string', pattern: OIDC_HOST_PATTERN },

    clientId: { type: 'string', minLength: 1 },
    clientSecret: {
      type: 'object',
      additionalProperties: false,
      required: ['secret'],
      properties: { secret: { type: 'string', minLength: 1 } },
    },
    tokenEndpointAuth: { type: 'string', enum: ['client_secret_basic', 'client_secret_post'] },
    redirectUri: { type: 'string', minLength: 1 },
    scopes: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: SCOPE_TOKEN_PATTERN } },
    claims: {
      type: 'object',
      additionalProperties: false,
      properties: { subject: claimPath, email: optionalClaimPath, emailVerified: optionalClaimPath, name: optionalClaimPath, groups: optionalClaimPath },
    },
    algorithms: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: [...OIDC_SIGNING_ALGORITHMS] } },
    clockSkewSeconds: { type: 'integer', minimum: 0, maximum: 300 },
    userinfo: { type: 'boolean' },
    requiredClaims: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
    authorizationParams: {
      type: 'object',
      propertyNames: { not: { enum: [...OIDC_RESERVED_PARAMS] } },
      additionalProperties: { type: 'string' },
    },
    linking: {
      type: 'object',
      additionalProperties: false,
      properties: { jit: { type: 'boolean' }, byVerifiedEmail: { type: 'boolean' } },
    },
  },
  allOf: [
    {
      if: { type: 'object', not: { required: ['preset'] } },
      then: { type: 'object', required: ['issuer'], properties: only('issuer') },
    },
    branch('google', { properties: only() }),
    branch('entra', { required: ['tenant'], properties: only('tenant') }),
    branch('keycloak', { required: ['baseUrl', 'realm'], properties: only('baseUrl', 'realm') }),
    branch('auth0', { required: ['domain'], properties: only('domain') }),
    branch('okta', { required: ['domain'], properties: only('domain', 'authorizationServer') }),
    branch('github', { properties: { ...only('host'), userinfo: { const: true } } }),
  ],
} as const;

/** authn.oidc (OidcConfig). */
export const AUTHN_OIDC_CONFIGURATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    providers: {
      type: 'object',
      propertyNames: { pattern: OIDC_PROVIDER_NAME_PATTERN },
      additionalProperties: AUTHN_OIDC_PROVIDER_SCHEMA,
    },
    redirects: {
      type: 'object',
      additionalProperties: false,
      properties: {
        success: { type: 'string', pattern: OIDC_APP_PATH_PATTERN },
        failure: { type: 'string', pattern: OIDC_APP_PATH_PATTERN },
      },
    },
  },
} as const;
