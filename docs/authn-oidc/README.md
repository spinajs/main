# `@spinajs/authn-oidc`

Sign-in through an external identity provider with OpenID Connect, or plain OAuth2 for GitHub. Each configured provider becomes the authentication strategy `oidc:<name>`, with the authorization code flow, PKCE S256, full ID token checks, claims mapping, identity linking and presets for Google, Microsoft Entra ID, Keycloak, Auth0, Okta and GitHub.

It does **not** issue sessions, store links or decide who may sign in: `@spinajs/authn` does, through `AuthnService`, with the stores of `@spinajs/authn-orm`. It does not change the authn core. 2.x had no OIDC, so there is nothing to migrate.

## Install

```sh
npm install @spinajs/authn-oidc
```

It depends on `@spinajs/authn`, `@spinajs/authn-orm`, `@spinajs/authn-session` and `@spinajs/authn-http`. Import `@spinajs/authn-oidc` in the app entry: its bootstrapper registers the `oidc:<name>` strategies. The app also needs:

- `NonceStore` and `IdentityLinkStore`: `@spinajs/authn-orm` registers `DbNonceStore` and `DbIdentityLinkStore` (tables `authn_nonce`, `authn_identity`).
- `AuthnService` (`@spinajs/authn`) and `SessionIssuer` (`@spinajs/authn-session`).
- `@spinajs/authn-http`, which restores the session, writes `ClientIp` for the throttle and guards the link routes against CSRF.
- An `IdentityStore`, usually from `@spinajs/users`, for email matching and the core's status checks.

## Features

| Feature | What it does |
| --- | --- |
| [Login flow](01-login-flow.md) | `GET /auth/oidc/:provider` and its callback: flow cookie, state, nonce, PKCE, token exchange, ID token, userinfo, session, answers |
| [Provider configuration](02-provider-configuration.md) | Every `authn.oidc.*` key, the boot checks, and how `OidcBootstrapper` registers one strategy per provider |
| [Presets](03-presets.md) | `google`, `entra`, `keycloak`, `auth0`, `okta`, `github`: issuer or endpoints, scopes, mapping, client auth |
| [Claims mapping](04-claims-mapping.md) | Claim paths to subject, email, verified flag, name and groups; `requiredClaims` |
| [Identity linking](05-identity-linking.md) | Map a `(provider, subject)` to a local identity: stored link, verified email, JIT, both switches |
| [Account linking](06-account-linking.md) | `POST` and `DELETE /auth/oidc/:provider/link` for a signed-in user; the `OidcAccountLinks` extension point |
| [External login hooks](07-external-login-hooks.md) | `ExternalLoginHook`: run code with the mapped claims on every OIDC login, or refuse it |
| [Provider HTTP client, discovery and keys](08-http-client.md) | `OidcHttpClient` extension point; discovery and JWKS caching and validation |
| [Security guarantees](09-security.md) | Every check of the flow, what is fixed, and the limits of 3.0 |
| [Programmatic API](10-programmatic-api.md) | `OidcLogin`, `OidcProvider`, `OidcStrategy` and the pure step functions, for custom controllers and tests |

## Quick start

```ts sample
import type { OidcConfig } from '@spinajs/authn-oidc';

const oidc: OidcConfig = {
  providers: {
    corp: {
      issuer: 'https://sso.example.com/realms/corp',
      clientId: 'reports-app',
      clientSecret: { secret: 'env://OIDC_CORP_SECRET' },
    },
  },
  redirects: { success: '/app', failure: '/login' },
};

// config/authn.ts of the app
export default {
  authn: {
    strategies: [
      { name: 'local', service: 'LocalPasswordStrategy' },
      { name: 'oidc:corp', service: 'oidc:corp' },
    ],
    oidc,
  },
};
```

Register `https://<your host>/auth/oidc/corp/callback` at the IdP, then link to `/auth/oidc/corp?returnTo=/app`. A first login of an unlinked user fails until you link the account ([Account linking](06-account-linking.md)) or turn on [identity linking](05-identity-linking.md).

## Related packages

- [`@spinajs/authn`](../authn/README.md): `AuthnService`, the strategy registry, `authn.linking`, `ExternalLoginHook`, `AccountLinkService`.
- [`@spinajs/authn-orm`](../authn-orm/README.md): [identity links](../authn-orm/03-identity-links.md) in `authn_identity` and the [nonce store](../authn-orm/04-nonce-store.md) that claims each state once.
- [`@spinajs/authn-http`](../authn-http/README.md): session restore, `ClientIp`, the CSRF origin guard and `authn.http.trustProxy`.
- [`@spinajs/users`](../users/README.md): `UserIdentityStore`, the identity store behind linking and status checks.
- [Authentication internals](../authn-oidc/01-login-flow.md): the OIDC steps next to the other login types.
