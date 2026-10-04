# `@spinajs/authn-oidc`

OpenID Connect and OAuth2 login for SpinaJS (design §22.15, rule A27): the
authorization code flow with PKCE S256, discovery, full ID token checks,
userinfo, claims mapping, account linking and provider presets (Google,
Microsoft Entra ID, Keycloak, Auth0, Okta, GitHub).

## Setup

```ts
export default {
  authn: {
    strategies: [{ name: 'oidc:corp', service: 'oidc:corp' }],
    oidc: {
      providers: {
        corp: { issuer: 'https://sso.example.com/realms/corp', clientId: 'canvas', clientSecret: { secret: 'env://OIDC_SECRET' } },
      },
      redirects: { success: '/app', failure: '/login' },
    },
  },
};
```

- Each provider becomes the strategy `oidc:<name>`. The package's
  bootstrapper registers one strategy service per provider under that same
  name, so list `{ name: 'oidc:<name>', service: 'oidc:<name>' }`.
- Routes: `GET /auth/oidc/:provider` (optional `?returnTo=/path`),
  `GET /auth/oidc/:provider/callback`, and for linking
  `POST` / `DELETE /auth/oidc/:provider/link`.
- The provider must have `<origin>/auth/oidc/<name>/callback` registered
  exactly, or the `redirectUri` you configure. The origin follows
  `authn.http.trustProxy` (else `http.trustProxy`): forwarded proto and host
  count only from a trusted proxy. Behind a TLS proxy without that setting the
  derived origin is http, which the provider refuses; a warning says so.
- Needs `NonceStore` and `IdentityLinkStore` (`@spinajs/authn-orm`: tables
  `authn_nonce`, `authn_identity`), `AuthnService`, `SessionIssuer`, and for
  linking an `OidcAccountLinks` registration (see below).

## Behaviour

- **Flow cookie.** The flow lives in an HttpOnly, SameSite=Lax cookie
  (`__Host-spinajs-oidc` outside development and test) holding a random seed.
  State, nonce and the PKCE verifier derive from it; the state also binds the
  provider, the time, the return path, the redirect URI and the mode. A state
  is claimed once in `authn_nonce`, before any call to the provider. A flow
  lives 10 minutes.
- **Checks.** Discovery issuer equal to the configured one; https everywhere
  outside development and test; RFC 9207 `iss` when sent, and required when
  the provider advertises it; ID token `iss` (or a preset alias), `aud`,
  `azp`, `exp`, `iat`, `nbf`, `nonce`, algorithm allow-list (never `none`,
  never HMAC), `at_hash` when present; userinfo `sub` equal to the ID
  token's. Discovery is cached an hour; the JWKS an hour, refreshed on an
  unknown `kid` at most once a minute.
- **Answers.** Every failure is the login failure (401 `E_AUTH_FAILED`, with
  `Retry-After` when throttled). A browser navigation goes to
  `redirects.failure` instead, with no reason. On success a browser gets a
  small same-site page that moves it on to the return path, because a
  SameSite=Strict session cookie does not travel on the cross-site redirect
  chain; other clients get a 303.
- **Linking.** An unlinked subject logs in only when both the global
  `authn.linking` switch and the provider's `linking` switch are on, for JIT
  and for matching by verified email alike. Without the provider's
  `byVerifiedEmail`, hooks and the core see `emailVerified: false` even when
  the provider said true. Entra and GitHub never mark an email verified.
- **Hooks.** Every `ExternalLoginHook` gets the identity and the mapped
  subject (`claims.name`, `claims.groups`, `claims.raw`). A throwing hook
  fails the login, revokes the session and audits a `login` failure with
  reason `hook_error` (the core has audited the success before the hooks
  run), so hooks must be idempotent.
  Group sync to authz is an app's hook (authn never imports authz).

## Not in this package

- `OidcAccountLinks` defaults to `CoreOidcAccountLinks`, which delegates to
  the core's `AccountLinkService` (fresh session, subject not linked
  elsewhere, never the last credential).
- The link routes read the restored session from
  `req.storage.AuthnSession`, which authn-http's middleware writes.
