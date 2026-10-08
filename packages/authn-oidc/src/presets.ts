import type { OidcClaimsMapping, OidcEndpoints, OidcPreset, OidcPresetId, OidcProviderSource } from './contracts.js';
import { deepFreeze } from './support.js';

const OIDC_SCOPES = ['openid', 'email', 'profile'];

export const DEFAULT_CLAIMS: OidcClaimsMapping = deepFreeze({ subject: 'sub', email: 'email', emailVerified: 'email_verified', name: 'name', groups: 'groups' });

const GITHUB_HOST = 'github.com';

export const OIDC_PRESETS: Readonly<Record<OidcPresetId, OidcPreset>> = deepFreeze({
  google: {
    id: 'google',
    idToken: true,
    issuer: 'https://accounts.google.com',
    // Google documents both forms of iss in its ID tokens.
    issuerAliases: ['accounts.google.com'],
    scopes: OIDC_SCOPES,
    claims: { ...DEFAULT_CLAIMS, groups: null },
    tokenEndpointAuth: 'client_secret_basic',
  },
  entra: {
    id: 'entra',
    idToken: true,
    issuer: 'https://login.microsoftonline.com/{tenant}/v2.0',
    scopes: OIDC_SCOPES,
    // Entra's email claim is mutable and unverified (nOAuth), so it never counts as verified.
    claims: { ...DEFAULT_CLAIMS, emailVerified: null },
    tokenEndpointAuth: 'client_secret_basic',
  },
  keycloak: {
    id: 'keycloak',
    idToken: true,
    issuer: '{baseUrl}/realms/{realm}',
    scopes: OIDC_SCOPES,
    claims: DEFAULT_CLAIMS,
    tokenEndpointAuth: 'client_secret_basic',
  },
  auth0: {
    id: 'auth0',
    idToken: true,
    issuer: 'https://{domain}/',
    scopes: OIDC_SCOPES,
    // Auth0 sends groups only through a namespaced custom claim the app names.
    claims: { ...DEFAULT_CLAIMS, groups: null },
    tokenEndpointAuth: 'client_secret_basic',
  },
  okta: {
    id: 'okta',
    idToken: true,
    issuer: 'https://{domain}/oauth2/{authorizationServer}',
    scopes: OIDC_SCOPES,
    claims: DEFAULT_CLAIMS,
    tokenEndpointAuth: 'client_secret_basic',
  },
  github: {
    id: 'github',
    idToken: false,
    endpoints: githubEndpoints(GITHUB_HOST),
    scopes: ['read:user', 'user:email'],
    claims: { subject: 'id', email: 'email', emailVerified: null, name: 'name', groups: null },
    tokenEndpointAuth: 'client_secret_post',
  },
} satisfies Record<OidcPresetId, OidcPreset>);

function githubEndpoints(host: string): OidcEndpoints {
  return {
    authorization: `https://${host}/login/oauth/authorize`,
    token: `https://${host}/login/oauth/access_token`,
    userinfo: host === GITHUB_HOST ? 'https://api.github.com/user' : `https://${host}/api/v3/user`,
  };
}

const fill = (template: string, values: Readonly<Record<string, string>>): string => template.replace(/\{(\w+)\}/g, (_, k: string) => values[k]);

/** The issuer a source resolves to; throws for GitHub, which has none. Inputs are assumed checked by the config reader. */
export function resolveIssuer(source: OidcProviderSource): string {
  switch (source.preset) {
    case undefined:
      return source.issuer;
    case 'google':
      return OIDC_PRESETS.google.issuer!;
    case 'entra':
      return fill(OIDC_PRESETS.entra.issuer!, { tenant: source.tenant.toLowerCase() });
    case 'keycloak':
      return fill(OIDC_PRESETS.keycloak.issuer!, { baseUrl: source.baseUrl.replace(/\/+$/, ''), realm: source.realm });
    case 'auth0':
      return fill(OIDC_PRESETS.auth0.issuer!, { domain: source.domain });
    case 'okta':
      return source.authorizationServer === null ? `https://${source.domain}` : fill(OIDC_PRESETS.okta.issuer!, { domain: source.domain, authorizationServer: source.authorizationServer ?? 'default' });
    case 'github':
      throw new Error('authn-oidc: the github preset has no issuer');
  }
}

/** The fixed endpoints of a plain OAuth2 source (GitHub); throws for the others, which use discovery. */
export function resolveEndpoints(source: OidcProviderSource): OidcEndpoints {
  if (source.preset !== 'github') {
    throw new Error(`authn-oidc: the ${source.preset ?? 'generic'} source finds its endpoints by discovery`);
  }
  return githubEndpoints(source.host ?? GITHUB_HOST);
}
