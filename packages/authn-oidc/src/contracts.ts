import type { ExternalSubject } from '@spinajs/authn/contracts';

export type OidcPresetId = 'google' | 'entra' | 'keycloak' | 'auth0' | 'okta' | 'github';

/** Every OidcPresetId once, for the config schema's enum. */
export const OIDC_PRESET_IDS: readonly OidcPresetId[] = Object.freeze(['google', 'entra', 'keycloak', 'auth0', 'okta', 'github']);

/** Asymmetric only: never 'none', and never HMAC, whose key would be the client secret or, misused, a public key. */
export type OidcSigningAlgorithm = 'RS256' | 'RS384' | 'RS512' | 'PS256' | 'PS384' | 'PS512' | 'ES256' | 'ES384' | 'ES512' | 'EdDSA';

/** Every OidcSigningAlgorithm once, for the config schema's enum and the default allow-list. */
export const OIDC_SIGNING_ALGORITHMS: readonly OidcSigningAlgorithm[] = Object.freeze(['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']);

/** As authn.local.pepper: a reference the configuration resolves (env or aws protocol); never logged or returned. */
export interface OidcSecretRef {
  readonly secret: string;
}

export type OidcTokenEndpointAuth = 'client_secret_basic' | 'client_secret_post';

/** A top-level claim name (dots belong to the name, as in Auth0's namespaced claims), or a path into nested objects. */
export type OidcClaimPath = string | readonly string[];

/** null: not mapped. */
export interface OidcClaimsMapping {
  /**
   * Default 'sub' (GitHub: 'id'). An immutable subject the provider never reassigns: never an email, upn, preferred_username,
   * login or name, which N10 refuses at boot (nOAuth). Changing it unlinks every user of the provider.
   */
  readonly subject: OidcClaimPath;
  /** Default 'email'. */
  readonly email: OidcClaimPath | null;
  /** Default 'email_verified'. Only a boolean true marks the email verified; anything else leaves it unverified. */
  readonly emailVerified: OidcClaimPath | null;
  /** Default 'name'. */
  readonly name: OidcClaimPath | null;
  /** Default 'groups'. A string is one group; non-string items are dropped. Unmapped or missing: hooks must leave memberships alone. */
  readonly groups: OidcClaimPath | null;
}

/** Absolute URLs. */
export interface OidcEndpoints {
  readonly authorization: string;
  readonly token: string;
  readonly userinfo: string;
}

/**
 * The flow's own parameters, which OidcStrategy sets, and max_age and acr_values, whose auth_time and acr answers nothing
 * checks in 3.0.
 */
export type OidcReservedParam = 'response_type' | 'response_mode' | 'client_id' | 'redirect_uri' | 'scope' | 'state' | 'nonce' | 'code_challenge' | 'code_challenge_method' | 'request' | 'request_uri' | 'max_age' | 'acr_values';

export type OidcAuthorizationParams = Readonly<Record<string, string>> & { readonly [P in OidcReservedParam]?: never };

/** An app-relative path: one leading '/', never '//' or '/\' (N10 checks what a type cannot). */
export type OidcAppPath = `/${string}`;

/** A Microsoft Entra tenant id (a GUID); N10's schema checks the full pattern. */
export type OidcEntraTenantId = `${string}-${string}-${string}-${string}-${string}`;

export interface OidcClientConfig {
  readonly clientId: string;
  /** Required: 3.0 has confidential clients only. A later RFC may add an explicit public-client mode, never one inferred from a missing secret. */
  readonly clientSecret: OidcSecretRef;
  /** Default: the preset's, else 'client_secret_basic'. */
  readonly tokenEndpointAuth?: OidcTokenEndpointAuth;
  /**
   * Absolute; the provider must have it registered exactly. Default: the callback route on the request's origin, resolved through
   * authn.http.trustProxy as ClientIp does. Kept with the state and sent unchanged to the token endpoint; the provider's exact match
   * is the guard.
   */
  readonly redirectUri?: string;
  /** Default: the preset's, else ['openid', 'email', 'profile']; an ID token provider always gets 'openid'. */
  readonly scopes?: readonly string[];
  /** Merged member by member over the preset's mapping, or the defaults. */
  readonly claims?: Partial<OidcClaimsMapping>;
  /** Default: OIDC_SIGNING_ALGORITHMS. The token's alg must be listed and fit the JWK (key type, and its alg when the JWK names one). */
  readonly algorithms?: readonly OidcSigningAlgorithm[];
  /** Leeway for exp, nbf and iat, in seconds; default 30, as authn.jwt. */
  readonly clockSkewSeconds?: number;
  /** Fetch userinfo after the token exchange; default true when the provider has a userinfo endpoint (an OAuth2-only preset always does). */
  readonly userinfo?: boolean;
  /** Top-level claims the login must carry with exactly these values, e.g. { hd: 'example.com' } or { tid: '<tenant id>' }; else the A02 failure. */
  readonly requiredClaims?: Readonly<Record<string, string | number | boolean>>;
  /** Extra authorization request parameters (prompt, login_hint, hd, domain_hint); never the reserved ones. */
  readonly authorizationParams?: OidcAuthorizationParams;
  /** Each switch needs the authn.linking switch of the same name on too, so adding a provider never opens sign-up or email matching. */
  readonly linking?: {
    /** JIT through IdentityStore.provision for this provider, only when authn.linking.jit is on too. Default false. */
    readonly jit?: boolean;
    /**
     * A first login links to the identity of the same email when the provider marks the email verified, only when
     * authn.linking.byVerifiedEmail is on too. Default false.
     */
    readonly byVerifiedEmail?: boolean;
  };
}

export type OidcProviderSource =
  | {
      readonly preset?: undefined;
      /** Found by discovery at <issuer>/.well-known/openid-configuration. sub is unique per issuer only: a new issuer needs a new name. */
      readonly issuer: string;
    }
  | { readonly preset: 'google' }
  | {
      readonly preset: 'entra';
      /** One tenant, by id: a domain or 'common', 'organizations', 'consumers' would not match the iss of the tenant's tokens. */
      readonly tenant: OidcEntraTenantId;
    }
  | {
      readonly preset: 'keycloak';
      /** Issuer {baseUrl}/realms/{realm}. */
      readonly baseUrl: string;
      readonly realm: string;
    }
  | {
      readonly preset: 'auth0';
      /** Issuer https://{domain}/. */
      readonly domain: string;
    }
  | {
      readonly preset: 'okta';
      /** Issuer https://{domain}/oauth2/{authorizationServer}. */
      readonly domain: string;
      /** Default 'default'; null: the org authorization server, issuer https://{domain}. */
      readonly authorizationServer?: string | null;
    }
  | {
      readonly preset: 'github';
      /** GitHub Enterprise Server host; default github.com. N10 builds its endpoints (https://{host}/login/oauth/…, https://{host}/api/v3/user). */
      readonly host?: string;
      /** The subject comes from userinfo, so it cannot be turned off. */
      readonly userinfo?: true;
    };

/**
 * authn.oidc.providers.<name>. Fixed, not configurable: authorization code flow only (no implicit or hybrid flow); PKCE S256;
 * state and nonce single use, and state bound to the browser that started the flow and to this provider (the callback's provider
 * must be the state's: mix-up); the RFC 9207 iss response parameter checked when sent; every provider endpoint (discovery, JWKS,
 * authorization, token, userinfo) over https unless the env is development or test; the discovery issuer equal to the configured one.
 * ID token: iss exact (or one of the preset's issuerAliases); aud holds clientId and no other audience; azp equals clientId when
 * present or when aud has several values; exp, iat, and nbf when present, within clockSkewSeconds; nonce; alg in algorithms;
 * at_hash when present. The userinfo sub equals the ID token's. Every failure is the A02 answer.
 */
export type OidcProviderConfig = OidcClientConfig & OidcProviderSource;

/** authn.oidc. */
export interface OidcConfig {
  /**
   * By name (1–59 of [a-z0-9_-], so 'oidc:<name>' fits 64): strategy 'oidc:<name>', routes /auth/oidc/<name> and its /callback.
   * Every link it makes has provider 'oidc:<name>' (authn_identity), so renaming a provider unlinks its users.
   */
  readonly providers: Readonly<Record<string, OidcProviderConfig>>;
  /**
   * Where the callback sends the browser; default '/' for both. The failure redirect carries no reason (A02). A returnTo is
   * accepted only as an app-relative path, kept with the state; anything else falls back to success (no open redirect).
   */
  readonly redirects?: {
    readonly success?: OidcAppPath;
    readonly failure?: OidcAppPath;
  };
}

/** N10 ships one per OidcPresetId; a provider config fills the '{name}' placeholders of its issuer. */
export type OidcPreset = {
  readonly id: OidcPresetId;
  readonly scopes: readonly string[];
  readonly claims: OidcClaimsMapping;
  readonly tokenEndpointAuth: OidcTokenEndpointAuth;
} & (
  | {
      readonly idToken: true;
      /** e.g. 'https://login.microsoftonline.com/{tenant}/v2.0'; discovery finds the endpoints. */
      readonly issuer: string;
      /** Other iss values the provider documents for the same issuer, e.g. Google's 'accounts.google.com'. */
      readonly issuerAliases?: readonly string[];
      readonly endpoints?: never;
    }
  | {
      /** Plain OAuth2 (GitHub): no ID token, no discovery; the subject comes from userinfo. */
      readonly idToken: false;
      readonly issuer?: never;
      readonly issuerAliases?: never;
      readonly endpoints: OidcEndpoints;
    }
);

/** The strategy name, also ExternalSubject.provider of an OIDC login. */
export type OidcStrategyName = `oidc:${string}`;

/** ExternalSubject.claims of an OIDC login. */
export type OidcMappedClaims = {
  readonly name?: string;
  /** Absent when unmapped or missing from the login, which is not the same as []. */
  readonly groups?: readonly string[];
  /** The validated ID token's claims, then the userinfo claims it lacks; never a token. */
  readonly raw: Readonly<Record<string, unknown>>;
};

/** What OidcStrategy returns and every ExternalLoginHook receives. */
export interface OidcExternalSubject extends ExternalSubject {
  readonly provider: OidcStrategyName;
  readonly claims: OidcMappedClaims;
}
