# OIDC single sign-on (`@spinajs/authn-oidc`)

`authn-oidc` logs users in through an external identity provider, with OpenID Connect or (for GitHub)
plain OAuth2. It is an `AuthenticationStrategy` named `oidc:<name>`. It returns an external subject,
and `authn` links that subject to a local identity through `authn_identity`. It does not change the
authn core (§22.15, A27).

- Overview of authentication: [README](./README.md).
- Moving a 2.x app: 2.x had no OIDC. Nothing to convert.
- Rule numbers (A19, A27) point to `docs/plans/2026-10-01-authz-v3-design.md` (§22.17).
- Source of the facts below: the lane N10 report and `packages/authn-oidc`.

## What it does

- **Discovery.** Endpoints come from `<issuer>/.well-known/openid-configuration`. The issuer in the
  discovery document must equal the configured one. Discovery is cached for an hour, and so is the
  JWKS, which refreshes on an unknown `kid` at most once a minute.
- **Authorization code flow with PKCE S256.** No implicit and no hybrid flow.
- **`state` and `nonce` are single use.** The flow lives in a cookie (see Flow cookie). `state` is bound
  to the browser that started the flow and to the provider, so a callback for another provider is
  refused (mix-up). The RFC 9207 `iss` response parameter is checked when the provider sends it, and
  required when the provider advertises it.
- **Every provider endpoint uses https** (discovery, JWKS, authorization, token, userinfo), unless the
  env is development or test. With no env set, the code resolves to development (the configuration
  falls back to it), so plain http passes too. Set `APP_ENV` or `NODE_ENV` explicitly
  (TODO(N8a): a missing env will mean production). The HTTP client follows no redirects, accepts a JSON content type only,
  times out after 5 seconds and reads at most 1 MiB.
- **ID token checks:** `iss` exact (or an alias the preset lists), `aud` holds the client id and no other
  audience, `azp` equals the client id when present or when `aud` has several values, `exp`, `iat` and
  `nbf` within the clock skew (30 s), `nonce`, an algorithm from the allow-list, and `at_hash` when
  present. The allow-list holds asymmetric algorithms only: never `none`, never HMAC.
- **Userinfo.** Fetched after the token exchange when the provider has an endpoint. Its `sub` must equal
  the ID token's.
- **Every failure is the same answer as a bad password (A02).** See Routes.

## Providers

You configure a provider under `authn.oidc.providers.<name>`. The name is 1-59 characters of
`[a-z0-9_-]`. It gives the strategy name `oidc:<name>` and the routes `GET /auth/oidc/<name>` and
`GET /auth/oidc/<name>/callback`. **Renaming a provider unlinks its users**, because every link stores
the provider as `oidc:<name>`.

The package's bootstrapper registers one strategy service per configured provider, with the same
name. List each in `authn.strategies` with that name as the `service`. Your app must import
`@spinajs/authn-oidc`: the controller scan alone does not register the strategies.

```ts
authn: {
  strategies: [{ name: 'oidc:corp', service: 'oidc:corp' }],
  linking: { jit: false, byVerifiedEmail: false },
  oidc: {
    redirects: { success: '/', failure: '/login' },
    providers: {
      corp: {
        issuer: 'https://sso.example.com/realms/corp',     // found by discovery
        clientId: 'my-app',
        clientSecret: { secret: 'env://OIDC_SECRET' },     // a secret reference, never an inline value
        claims: { groups: 'groups' },
        requiredClaims: { hd: 'example.com' },
      },
    },
  },
}
```

The configuration resolves `clientSecret.secret`. The options object keeps it readable to the code, but
JSON and `util.inspect` show `[redacted]`, so a dump never leaks it. A bare string is refused: the
value must be the `{ secret }` object.

Provider keys:

| Key | Meaning |
|---|---|
| `issuer` | A generic provider, found by discovery. `sub` is unique per issuer only, so a new issuer needs a new provider name. |
| `preset` | One of the presets below. A preset fills the issuer or the endpoints. Each preset takes only its own extra keys. |
| `clientId`, `clientSecret` | Required. `clientSecret` is `{ secret }`, a secret reference. |
| `tokenEndpointAuth` | `client_secret_basic` (default; GitHub's preset uses `client_secret_post`) or `client_secret_post`. |
| `redirectUri` | Absolute, and registered exactly at the provider. Default: the callback route on the request's origin, resolved through `authn.http.trustProxy`, else `http.trustProxy`. |
| `scopes` | Default: the preset's, else `['openid', 'email', 'profile']`. `openid` is added for an OIDC provider when you leave it out. |
| `claims` | Maps `subject` (default `sub`; GitHub `id`), `email`, `emailVerified`, `name` and `groups`. A path or a list of keys for a nested claim; `null` means not mapped (not allowed for `subject`). |
| `algorithms` | Allowed ID token algorithms. Default: all asymmetric ones (`OIDC_SIGNING_ALGORITHMS`). |
| `clockSkewSeconds` | Leeway for time claims, 0 to 300. Default 30. |
| `userinfo` | Fetch userinfo. Default: when the provider has an endpoint. GitHub requires `true`. |
| `requiredClaims` | Top-level claims the login must carry with exactly these values, such as `{ hd: 'example.com' }`. Else the login fails. Numbers must be finite. |
| `authorizationParams` | Extra authorization request parameters (`prompt`, `login_hint`, `hd`, `domain_hint`). The flow's own parameters (`response_type`, `response_mode`, `client_id`, `redirect_uri`, `scope`, `state`, `nonce`, `code_challenge`, `code_challenge_method`), `request`, `request_uri`, `max_age` and `acr_values` are refused. |
| `linking.jit`, `linking.byVerifiedEmail` | Per-provider switches. See Linking. |

`authn.oidc.redirects.success` and `.failure` are app-relative paths (default `/`): one leading `/`,
never `//`, and no backslash, space or control character. A `returnTo` is kept with the flow and
accepted only as an app-relative path. Anything else falls back to the success redirect, so there is
no open redirect.

## Presets

A preset sets the issuer or endpoints, the scopes, the claim mapping and the token endpoint
authentication of a well-known provider. `OIDC_PRESET_IDS` lists them and is exported from the
package.

| Preset | Provider | Extra keys | Mapping and scopes |
|---|---|---|---|
| `google` | Google | none | Issuer `https://accounts.google.com`; the alias `accounts.google.com` is also accepted as `iss`. `groups` is not mapped. |
| `entra` | Microsoft Entra ID | `tenant`: one tenant GUID (see Limits). Issuer `https://login.microsoftonline.com/<tenant>/v2.0`. | `emailVerified` is not mapped: Entra's email claim is mutable and unverified (nOAuth), so it never counts as verified. |
| `keycloak` | Keycloak | `baseUrl`, `realm`. Issuer `<baseUrl>/realms/<realm>`. | Default mapping. |
| `auth0` | Auth0 | `domain`. Issuer `https://<domain>/`. | `groups` is not mapped: Auth0 sends groups only in a namespaced custom claim you name. |
| `okta` | Okta | `domain`, `authorizationServer` (default `default`; `null` for the org server, issuer `https://<domain>`). Issuer `https://<domain>/oauth2/<authorizationServer>`. | Default mapping. |
| `github` | GitHub, OAuth2 only, no ID token | `host` for GitHub Enterprise Server (default `github.com`). | Scopes `read:user` and `user:email`. Subject is the numeric `id`. `emailVerified` and `groups` are not mapped, so a GitHub email is never verified. Token endpoint auth `client_secret_post`. |

The default mapping is `subject: sub`, `email: email`, `emailVerified: email_verified`, `name: name`,
`groups: groups`, with the scopes `openid email profile`. GitHub has no ID token and no discovery. Its
endpoints are fixed (`https://github.com/login/oauth/authorize`, `.../access_token`, and
`https://api.github.com/user`; a GitHub Enterprise Server host uses `https://<host>/api/v3/user`). Its
subject comes from userinfo, so userinfo cannot be turned off for it.

A recorded discovery document for each preset is checked in the package tests: every preset resolves.

## Routes

The controller has the fixed prefix `auth/oidc`. It does not follow `authn.http.routes.prefix`.

| Route | Does |
|---|---|
| `GET /auth/oidc/:provider` | Starts a login. Optional `?returnTo=/path`. Sets the flow cookie and answers 302 to the provider. |
| `GET /auth/oidc/:provider/callback` | Finishes a login or a link flow. |
| `POST /auth/oidc/:provider/link` | Starts linking for the current session. Needs an active session and a same-origin request (`Sec-Fetch-Site` `same-origin` or `none`). It is a `POST`, so the origin check of `authn-http` (A22) is meant to guard it: a cross-site start could link another site's account to this identity. **TODO(N8a):** that check is `CsrfOriginGuard`, a stub today: it checks no `Origin` or `Sec-Fetch-Site` header. Only the route's own test remains. It refuses a `Sec-Fetch-Site` value other than `same-origin` or `none`, and lets a request with no such header through. |
| `DELETE /auth/oidc/:provider/link` | Removes the identity's link to this provider. `?subject=` names one when the identity holds several. 204 on success, 401 without a session, 404 when nothing is linked, 409 when several subjects match and none is named, 403 when the core refuses (the last usable credential). |

**Answers.** Every failure is the login failure: 401 with the `E_AUTH_FAILED` body of the login route,
plus `Retry-After` when throttled. A browser navigation goes to `redirects.failure` instead (303), with
no reason in the URL. On success a browser gets a small same-site page that moves it on to the return
path, and other clients get a 303. The reason is a `SameSite=Strict` session cookie: it does not travel
on the cross-site redirect chain, so the final hop has to start on your site.

The login runs through `AuthnService.authenticate`, so the throttle and audit of the core apply. The
strategy sends no throttle key of its own (no account is known before verification, and a
per-provider key would let one client slow every login), and the core adds the `ip` key. An IdP login
gets no core MFA step: the IdP does its own (D13).

## Flow cookie

The flow lives in an `HttpOnly`, `SameSite=Lax` cookie, named `__Host-spinajs-oidc` (with `Secure`)
outside development and test, and `spinajs-oidc` there. With no env set, the code resolves to
development, so you get the plain name without `Secure` (TODO(N8a): a missing env will mean
production; set the env explicitly). It holds a random 32-byte seed and the flow
fields. `state` is a SHA-256 over every member of the cookie (provider, seed, time, return path,
redirect URI, mode and, for linking, the session binding). The nonce and the PKCE verifier derive from
the seed. The server needs no key of its own. A flow lives 10 minutes. `state` is claimed once in
`authn_nonce`, before any call to the provider, so a replayed callback fails.

The tables `authn_nonce` and `authn_identity` come from `authn-orm` (`DbNonceStore`,
`DbIdentityLinkStore`). The strategy also needs `AuthnService` and a `SessionIssuer`.

## Linking

An external login proves a subject at a provider. `authn` maps it to an identity (A19):

1. If `(provider, subject)` is in `authn_identity`, that identity logs in.
2. Else, if both switches are on, the login may match or provision a local identity:
   - **Matching by email** needs `authn.linking.byVerifiedEmail: true` **and** the provider's
     `linking.byVerifiedEmail: true`. The provider must mark the email verified (only a boolean `true`
     counts), and the identity store must hold the **same email** for the identity it finds. Both
     switches default to false. Without the provider's switch, hooks and the core see
     `emailVerified: false` even when the provider said `true`.
   - **JIT provisioning** through `IdentityStore.provision` needs `authn.linking.jit: true` **and** the
     provider's `linking.jit: true`. Both default to false.
3. Else the login fails with `not_linked`, and the caller sees the opaque failure.

A provider switch that is on while the global one is off has no effect, and boot logs a warning.
Both switches exist so that adding a provider never opens sign-up or email matching by accident. The
strategy repeats the core's decision with the provider's switch, so neither path runs without it.

> **TODO(K6):** the global `authn.linking.jit` also gates JWT bearer provisioning (`authn-token`), and
> a JWT issuer has no switch of its own. Turning `jit` on for one OIDC provider therefore lets every
> listed `authn.jwt.issuers` entry provision identities too. K6 adds a per-issuer switch.

- One identity may hold many links. `(provider, subject)` is unique.
- Explicit linking needs the identity's own active session with fresh auth, and goes through the core's
  `AccountLinkService` (`OidcAccountLinks`, default `CoreOidcAccountLinks`). The link flow is bound to
  the session that started it. Without an `OidcAccountLinks` registration the link routes answer 404.
- Unlinking the last usable credential (no password, no other link, no key) is refused.
- The subject mapping must name a claim the provider never reassigns. Boot refuses `email`, `upn`,
  `preferred_username`, `login` and `name` as the subject. Changing the subject mapping unlinks every
  user of the provider.

## `ExternalLoginHook`

Authn imports no authz. To act on a login, such as syncing group claims into authorization data,
register an `ExternalLoginHook` (`Array.ofType`). It runs in the callback route after a successful
external login:

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
- **A hook that throws fails the login.** The route revokes the session and audits a `login` failure
  with the reason `hook_error`. The core has already audited the success, so the trail shows both.
  Make hooks idempotent. RFC N10-1 proposes that the core call the hooks before it issues the
  session; N10 works without it.

## Limits in 3.0

- **Confidential clients only.** A `clientSecret` is required. There is no public-client mode, and a
  missing secret never means one.
- **Microsoft Entra ID by one tenant GUID.** A domain, `common`, `organizations` or `consumers` would not
  match the `iss` of the tenant's tokens. Multi-tenant comes later.
- **JIT and email linking need both switches** (global and per provider). The global JIT switch also
  gates JWT bearer provisioning (TODO(K6)).
- **`max_age` and `acr_values` are refused** in `authorizationParams`: nothing checks `auth_time` or `acr`
  in 3.0.
- No implicit flow, no hybrid flow, no `request` or `request_uri` parameters.
- The route prefix is fixed at `auth/oidc`.
- Link callbacks are not throttled. `AccountLinkService` audits them.
- LDAP and SAML are later packages (`authn-ldap`, `authn-saml`).

## Boot checks

`authn.oidc` is read and checked when `OidcProviders` first resolves. That happens at the boot of
`AuthnService` when a provider is listed in `authn.strategies`, and otherwise on the first OIDC
request. A message names the provider and the key, never a value. Boot refuses:

- an unknown key in `authn.oidc`, or a provider with a key that is not in the table above;
- a provider name outside `[a-z0-9_-]{1,59}`;
- an `entra` provider whose `tenant` is not a GUID, and any preset with a missing or foreign extra key;
- `issuer` or `baseUrl` that is not an https URL without credentials, query or fragment, and a
  `redirectUri` that is not an absolute https URL without credentials or fragment (a query string is
  allowed). Http is allowed in development and test, which includes a deployment with no env set;
- a `claims.subject` of `email`, `upn`, `preferred_username`, `login` or `name`;
- a `redirects` path that is not app-relative;
- an `authorizationParams` key from the refused list, a `scopes` entry that is not an RFC 6749 scope
  token, a non-finite number in `requiredClaims`.

It only warns when a provider's `linking.<key>` is on and `authn.linking.<key>` is off. The
controller also warns once, on the first request, when the default redirect URI has an `http` origin
outside development and test (behind a TLS proxy, set `authn.http.trustProxy` or the provider's
`redirectUri`).

## Wiring and open items

- `authn-http` has to put `req.storage.AuthnSession` (link routes) and `req.storage.ClientIp` (the `ip`
  throttle key) in place, register the controller in its route group, and set the session cookie.
  Until N8a merges, OIDC callbacks have no `ip` throttle key and the link routes fail closed
  (TODO(N8a)).
- The CSRF origin guard (`CsrfOriginGuard`, A22) is a stub. It checks no `Origin` or `Sec-Fetch-Site`
  header, so the `POST /auth/oidc/:provider/link` start relies on its own `Sec-Fetch-Site` test alone
  (TODO(N8a)).
- A deployment with no env set runs in development mode: http provider URLs pass and the flow cookie
  is not `Secure`. Set `APP_ENV` or `NODE_ENV` (TODO(N8a): a missing env will mean production).
- Run the acceptance against a real Keycloak (`issuer`, `clientId`, `clientSecret`, and the redirect URI
  `<origin>/auth/oidc/<name>/callback` registered exactly), and check the success page in a browser
  (TODO(IC2)).

## Testing

The 3.0 acceptance (A27, plan N10) is a canvas-like setup: one generic provider configured only by its
issuer URL, the code flow with PKCE S256, full ID token validation, claims mapped to email and name,
login of a user already linked, a first login refused with `not_linked` while JIT is off, explicit
linking from a fresh session and the refusal to unlink the last credential. The tests run over real
HTTP against an in-memory fake IdP (bad `iss`, `aud`, `nonce`, an expired token, `alg: none`, a
replayed `state`), on SQLite and PostgreSQL. A run against a Keycloak container is not part of the
lane. The behaviour rule A27 and its cases live in `@spinajs/authn-testing`.
