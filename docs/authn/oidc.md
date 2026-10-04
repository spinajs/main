# OIDC single sign-on (`@spinajs/authn-oidc`)

`authn-oidc` logs users in through an external identity provider, with OpenID Connect or (for GitHub)
plain OAuth2. It is an `AuthenticationStrategy` named `oidc:<name>`. It returns an external subject,
and `authn` links that subject to a local identity through `authn_identity`. It does not change the
authn core (§22.15, A27).

- Overview of authentication: [README](./README.md).
- Moving a 2.x app: 2.x had no OIDC. Nothing to convert.
- Rule numbers (A19, A27) point to `docs/plans/2026-10-01-authz-v3-design.md` (§22.17).

> **TODO(N10): this lane has not merged.** The design and the frozen contract
> (`packages/authn-oidc/src/contracts.ts`) fix what is below. N10 decides the rest. Replace each
> TODO block from the N10 report: the config keys as built, the routes, the preset list and the
> boot checks.

## What it does

- **Discovery.** Endpoints come from `<issuer>/.well-known/openid-configuration`. The issuer in the
  discovery document must equal the configured one.
- **Authorization code flow with PKCE S256.** No implicit and no hybrid flow.
- **`state` and `nonce` are single use.** `state` is bound to the browser that started the flow and to
  the provider, so a callback for another provider is refused (mix-up). The RFC 9207 `iss` response
  parameter is checked when the provider sends it.
- **Every provider endpoint uses https** (discovery, JWKS, authorization, token, userinfo), unless the
  env is development or test.
- **ID token checks:** `iss` exact (or an alias the preset lists), `aud` holds the client id and no other
  audience, `azp` equals the client id when present or when `aud` has several values, `exp`, `iat` and
  `nbf` within the clock skew (30 s), `nonce`, an algorithm from the allow-list, and `at_hash` when
  present. The allow-list holds asymmetric algorithms only: never `none`, never HMAC.
- **Userinfo.** Fetched after the token exchange when the provider has an endpoint. Its `sub` must equal
  the ID token's.
- **Every failure is the same answer as a bad password (A02).** The browser goes to the failure
  redirect, which carries no reason.

## Providers

You configure a provider under `authn.oidc.providers.<name>`. The name is 1-59 characters of
`[a-z0-9_-]`. It gives the strategy name `oidc:<name>` and the routes `GET /auth/oidc/<name>` and
`GET /auth/oidc/<name>/callback`. **Renaming a provider unlinks its users**, because every link stores
the provider as `oidc:<name>`.

```ts
authn: {
  linking: { jit: false, byVerifiedEmail: false },
  oidc: {
    redirects: { success: '/', failure: '/login' },
    providers: {
      corp: {
        issuer: 'https://sso.example.com/realms/corp',     // found by discovery
        clientId: 'my-app',
        clientSecret: { secret: '<secret reference>' },    // never an inline value
        claims: { groups: 'groups' },
        requiredClaims: { hd: 'example.com' },
      },
    },
  },
}
```

> **TODO(N10): config as built.** The sample follows the frozen contract. Add how a provider is
> listed in `authn.strategies` (the strategy `service` name), the secret reference syntax and the
> defaults from the N10 report.

Provider keys (from the frozen contract):

| Key | Meaning |
|---|---|
| `issuer` | A generic provider, found by discovery. `sub` is unique per issuer only, so a new issuer needs a new provider name. |
| `preset` | One of the presets below. A preset fills the issuer and the endpoints. |
| `clientId`, `clientSecret` | Required. `clientSecret` is a secret reference. |
| `tokenEndpointAuth` | `client_secret_basic` (default) or `client_secret_post`. |
| `redirectUri` | Absolute, and registered exactly at the provider. Default: the callback route on the request's origin, resolved through `authn.http.trustProxy`. |
| `scopes` | Default: the preset's, else `['openid', 'email', 'profile']`. |
| `claims` | Maps `subject` (default `sub`; GitHub `id`), `email`, `emailVerified`, `name` and `groups`. A path or a list of keys for a nested claim; `null` means not mapped. |
| `algorithms` | Allowed ID token algorithms. Default: all asymmetric ones. |
| `clockSkewSeconds` | Leeway for time claims. Default 30. |
| `userinfo` | Fetch userinfo. Default true when the provider has an endpoint. |
| `requiredClaims` | Top-level claims the login must carry with exactly these values, such as `{ hd: 'example.com' }`. Else the login fails. |
| `authorizationParams` | Extra authorization request parameters (`prompt`, `login_hint`, `hd`, `domain_hint`). The flow's own parameters, `max_age` and `acr_values` are refused. |
| `linking.jit`, `linking.byVerifiedEmail` | Per-provider switches. See Linking. |

`authn.oidc.redirects.success` and `.failure` are app-relative paths (default `/`). A `returnTo` is kept
with the state and accepted only as an app-relative path. Anything else falls back to the success
redirect, so there is no open redirect.

## Presets

A preset sets the issuer or endpoints, the scopes, the claim mapping and the token endpoint
authentication of a well-known provider. The contract lists six:

| Preset | Provider | Extra keys |
|---|---|---|
| `google` | Google | none |
| `entra` | Microsoft Entra ID | `tenant`: one tenant GUID (see Limits) |
| `keycloak` | Keycloak | `baseUrl`, `realm` (issuer `{baseUrl}/realms/{realm}`) |
| `auth0` | Auth0 | `domain` (issuer `https://{domain}/`) |
| `okta` | Okta | `domain`, `authorizationServer` (default `default`; `null` for the org server) |
| `github` | GitHub, OAuth2 only, no ID token | `host` for GitHub Enterprise Server (default `github.com`) |

The runtime lists `OIDC_PRESET_IDS` and `OIDC_SIGNING_ALGORITHMS` are exported from the package.
GitHub has no ID token and no discovery. Its subject comes from userinfo (the numeric `id`), so
userinfo cannot be turned off for it.

> **TODO(N10): presets as built.** Confirm the preset ids, the extra keys and the default scopes and
> claim mappings from the N10 report. Add a recorded-discovery check that each preset resolves.

## Linking

An external login proves a subject at a provider. `authn` maps it to an identity (A19):

1. If `(provider, subject)` is in `authn_identity`, that identity logs in.
2. Else, if both switches are on, the login may provision or match a local identity:
   - **JIT provisioning** through `IdentityStore.provision` needs `authn.linking.jit: true` **and**
     the provider's `linking.jit: true`. Both default to false.
   - **Matching by email** needs `authn.linking.byVerifiedEmail: true` **and** the provider's
     `linking.byVerifiedEmail: true`, and the provider must mark the email verified (only a boolean
     `true` counts). Both default to false.
3. Else the login fails with `not_linked`, and the caller sees the opaque failure.

Both switches exist so that adding a provider never opens sign-up or email matching by accident.

- One identity may hold many links. `(provider, subject)` is unique.
- Explicit linking needs the identity's own active session with fresh auth.
- Unlinking the last usable credential (no password, no other link, no key) is refused.
- The subject mapping must name a claim the provider never reassigns. N10 refuses `email`, `upn`,
  `preferred_username`, `login` and `name` as the subject at boot. Changing the subject mapping unlinks
  every user of the provider.

## `ExternalLoginHook`

Authn imports no authz. To act on a login, such as syncing group claims into authorization data,
register an `ExternalLoginHook` (`Array.ofType`). It runs after a successful external login:

```ts
import { ExternalLoginHook, IdentityRef, ExternalSubject } from '@spinajs/authn/contracts';

@Injectable(ExternalLoginHook)
export class GroupSync extends ExternalLoginHook {
  async afterLogin(identity: IdentityRef, external: ExternalSubject): Promise<void> {
    const groups = (external.claims as { groups?: string[] }).groups;
    if (groups === undefined) return;              // an unmapped or missing claim: leave memberships alone
    // call AuthzAdmin here, for example set.addMember for each group
  }
}
```

- The hook gets the mapped claims: `name`, `groups` (absent when unmapped or missing, which is not
  the same as `[]`) and `raw` (the validated ID token claims, then userinfo claims it lacks; never a
  token).
- **A hook that throws fails the login.** Make hooks idempotent.

## Limits in 3.0

- **Confidential clients only.** A `clientSecret` is required. There is no public-client mode, and a
  missing secret never means one.
- **Microsoft Entra ID by one tenant GUID.** A domain, `common`, `organizations` or `consumers` would not
  match the `iss` of the tenant's tokens. Multi-tenant comes later.
- **JIT and email linking need both switches** (global and per provider).
- **`max_age` and `acr_values` are refused** in `authorizationParams`: nothing checks `auth_time` or `acr`
  in 3.0.
- No implicit flow, no hybrid flow, no `request` or `request_uri` parameters.
- LDAP and SAML are later packages (`authn-ldap`, `authn-saml`).

> **TODO(N10): boot checks as built.** N10 checks at boot the tenant GUID, the provider names, a subject
> mapping that is not `email`, `upn` or `login`, and the redirects. List the exact messages. Also
> document the flow cookie (state is single use in `authn_nonce`) and the `authn_nonce` and
> `authn_identity` stores that N4 provides (`DbNonceStore`, `DbIdentityLinkStore`).

## Testing

The 3.0 acceptance (A27, plan N10) is a canvas-like setup: one generic provider configured only by its
issuer URL, the code flow with PKCE S256, full ID token validation, claims mapped to email and name,
login of a user already linked, a first login refused with `not_linked` while JIT is off, explicit
linking from a fresh session and the refusal to unlink the last credential. The tests run against a
Keycloak container and a fake IdP (bad `iss`, `aud`, `nonce`, an expired token, `alg: none`, a
replayed `state`). The behaviour rule A27 and its cases live in `@spinajs/authn-testing`.
