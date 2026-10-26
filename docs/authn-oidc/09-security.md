# Security guarantees

What the package checks on every OIDC login, what is fixed and cannot be turned off, and what 3.0 does not do. Each guarantee names the class that enforces it.

## How it works

The checks run in the order of the [login flow](01-login-flow.md). Any failed check throws inside `OidcProvider.complete()` or the functions it calls; `OidcStrategy.verify()` turns that into `invalid_credentials`, and the client gets one opaque answer.

### Fixed protocol choices

| Guarantee | Enforced by |
| --- | --- |
| Authorization code flow only: no implicit flow, no hybrid flow. `response_type` is always `code`. | `authorizationUrl()` |
| PKCE S256 on every flow, OIDC and plain OAuth2. | `authorizationUrl()`, `exchangeCode()` |
| `response_mode`, `request`, `request_uri`, `max_age` and `acr_values` are never sent. | `authorizationUrl()`, the schema's `OIDC_RESERVED_PARAMS` |
| Confidential clients only: a `clientSecret` is required. | the schema |
| Discovery must list `code` and `S256` when it lists supported values. | `OidcDiscovery.validate()` |

### Callback checks

| Threat | Defence | Enforced by |
| --- | --- | --- |
| CSRF on the callback, login fixation | `state` is a hash of the whole flow cookie and must match; the cookie is `HttpOnly` and `__Host-` outside development and test. | `flowSecrets()`, `OidcProvider.complete()` |
| Replayed callback | The state is claimed once in `NonceStore` before any call to the IdP. | `stateClaim()`, `NonceStore.claim()` |
| Stale flow | A flow lives 600 seconds and may be at most 60 seconds in the future. | `flowIsLive()` |
| IdP mix-up | The flow's provider must be the callback's provider. The RFC 9207 `iss` must equal the issuer when sent, and must be sent when discovery advertises it. | `OidcProvider.complete()` |
| Code interception | The token request carries the PKCE verifier, derived from a 32-byte random seed. | `exchangeCode()` |
| Open redirect | `returnTo` and `redirects.*` must be app-relative paths: one leading `/`, never `//` or `/\`, no space, backslash or control character. | `appPathOrNull()`, the schema's `OIDC_APP_PATH_PATTERN` |
| Host header injection in the redirect URI | The default `redirect_uri` and `post_logout_redirect_uri` use `authn.http.publicOrigin` when set. Otherwise `Host`, or `X-Forwarded-Host` from a trusted proxy, must give an origin `parseOrigin()` accepts, or the flow answers 400 `E_OIDC_ORIGIN`. A well-formed forged `Host` is refused by the IdP's exact match of the registered URI. | `checkedRequestOrigin()`, `OidcLogin`, `OidcProviders` (boot warning) |
| Account-linking CSRF | Link flows start by `POST` only, refuse a cross-site `Sec-Fetch-Site`, and are bound to the starting session. | `OidcLogin.beginLink()`, `OidcStrategy.verifyLink()` |

### ID token checks

`validateIdToken()` runs OIDC Core §3.1.3.7:

1. The token is a compact JWS of three base64url parts.
2. The header `alg` is in the provider's `algorithms`, and so in `OIDC_SIGNING_ALGORITHMS`: asymmetric only, never `none`, never HMAC. A `crit` header is refused.
3. `OidcJwks.key()` finds exactly one key of the provider that fits the algorithm, and `jose` verifies the signature with that algorithm only.
4. The payload is a JSON object in valid UTF-8.
5. `iss` equals the issuer, or an alias of the preset (Google's `accounts.google.com`).
6. `aud` holds the client id and no other audience.
7. `azp` equals the client id when present, and is required when `aud` has several values.
8. `exp` is a finite number in the future, `iat` is a finite number not in the future, and `nbf`, when present, is not in the future. Each within `clockSkewSeconds` (default 30).
9. `nonce` equals the flow's nonce (constant-time compare).
10. `sub` is a string of 1 to 255 characters.
11. `at_hash`, when present, matches the access token (the left half of its hash with the algorithm's hash function).
12. For a re-authentication only: `auth_time` is a finite number, not after now and not before the flow start, each within `clockSkewSeconds`.

The userinfo `sub` must then equal the ID token's.

### Transport and keys

| Guarantee | Enforced by |
| --- | --- |
| Every IdP URL is https outside development and test: issuer, discovery endpoints, JWKS, token, userinfo, and a configured `redirectUri`. A derived `http` redirect URI only logs a warning. | `checkedUrl()`, `buildOidcOptions()`, `OidcDiscovery`, `FetchOidcHttpClient` |
| The discovery `issuer` equals the configured issuer. | `OidcDiscovery.validate()` |
| No redirects followed, JSON answers only, 5-second timeout, 1 MiB body cap. | `FetchOidcHttpClient` |
| Published keys with private members, a non-signing `use` or `key_ops`, RSA under 2048 bits, or another curve are refused. | `OidcJwks` |
| An unknown `kid` refreshes the key set at most once a minute. | `OidcJwks.load()` |

### Identity and disclosure

| Guarantee | Enforced by |
| --- | --- |
| The subject mapping never names a mutable claim (`email`, `upn`, `preferred_username`, `login`, `name`): nOAuth. | `buildOidcOptions()` |
| A first login links by email only with both switches on, a boolean `true` verified flag from the same document as the email, and the identity's own stored email. | `OidcStrategy.gate()`, `mapClaims()`, `DefaultAuthnService` |
| JIT needs both switches on. | `OidcStrategy.gate()`, `DefaultAuthnService` |
| Every failure answers like a wrong password (401 `E_AUTH_FAILED`, or 303 to `redirects.failure` with no reason). | `OidcLogin.failure()` |
| The client secret prints as `[redacted]` in JSON and `util.inspect`; config errors name the key, never the value. | `buildOidcOptions()` |
| Answers carry `Cache-Control: no-store`; the success page sends no referrer. | `OidcResponse`, `OidcLogin` |

### Route inputs

The controller reads its input through decorated arguments (no `@Req()`), each checked against a schema whose `$id` starts with `authn.oidc.` and is validated without type coercion.

| Input | Rule |
| --- | --- |
| `:provider` | `^[A-Za-z0-9_-]{1,64}$` |
| `GET /:provider`, `GET /:provider/reauth` query | `returnTo` up to 1024 characters (a longer one is refused; a shorter one that is no app-relative path falls back to `redirects.success`); **any other key is refused** |
| `GET /:provider/callback` query | `code`, `state`, `iss`, `error`, `bounce`: strings of up to 4096 characters. **Other keys are allowed**: an IdP appends parameters of its own (`session_state`, `scope`, `authuser`), and refusing them would break the login. A repeated key is refused. |
| `DELETE /:provider/link` query | `subject` of 1 to 255 characters (an empty `?subject=` is refused); any other key is refused |
| `POST /:provider/backchannel-logout` | form only; `logout_token` required, 1 to 16384 characters; other form fields are ignored, because the sender is the IdP |
| Headers | `user-agent`, `accept`, `sec-fetch-*`, `cookie`: at most 16384 characters; `host`, `x-forwarded-proto`, `x-forwarded-host`: at most 2048; `content-type` of the back-channel route: at most 256 |

A `host` or trusted `x-forwarded-host` within those bounds that gives no valid origin answers `400 { error: { code: 'E_OIDC_ORIGIN' } }` on the routes that start a flow, unless `authn.http.publicOrigin` or the provider's `redirectUri` is set (see [Login flow](01-login-flow.md#important-behaviour)).

Input that fails these rules answers exactly as the login failure does (see [Login flow](01-login-flow.md)): `303` to the failure page for a browser navigation, otherwise `401` with the uniform failure body, and the flow cookie is cleared. The back-channel route answers `400 {"error":"invalid_request"}`. A `:provider` outside the pattern is an unknown provider, so the link routes answer the login failure for it where an unknown but well-formed name still answers `404`.

The flow cookie is read from the raw `Cookie` header (`@Header('cookie')`, capped like the other headers) and parsed inside the controller, not through `@Cookie()`: the flow cookie's name depends on the environment (`__Host-` outside development and test). `OidcLogin` still decodes and checks its value.

## Important behaviour

- **Nothing here is configurable off.** The provider keys narrow the checks (`algorithms`, `clockSkewSeconds`, `requiredClaims`); none widens them.
- **Development and test relax https and the cookie.** `http` URLs pass, and the flow cookie is `spinajs-oidc` without `Secure`. An unset env counts as production, so a staging host must set its env explicitly to get `http`.
- **The cookie has no server key.** It grants nothing without the IdP's code; a changed cookie yields a state the IdP never saw.
- **Errors are `@spinajs/exceptions` classes.** A refused callback, ID token, token key or link callback, and a login without a usable subject, throw `AuthenticationFailed`. A provider that answers badly (HTTP status, content type, size, discovery document, JWKS, token or userinfo response) or failed recently throws `UnexpectedServerError`. A bad call argument (an unknown provider name, a non-finite time, a URL the client refuses to fetch) throws `InvalidArgument`. The login and link routes turn each into the one failure answer.

## Limits in 3.0

- No public clients (no client without a secret).
- No `max_age` or `acr_values` in `authorizationParams`. Only a re-authentication sends `max_age=0` and checks `auth_time`; nothing checks `acr`.
- Entra ID by one tenant GUID only; no multi-tenant.
- No signed or encrypted userinfo answers.
- The route prefix is fixed at `auth/oidc`.
- Link callbacks are not throttled; `AccountLinkService` audits them.
- No core MFA step after an OIDC login with `DefaultMfaPolicy`: the IdP is expected to run its own.

## Best practices

- Run with an explicit app env in every deployment, so the https rule and the `__Host-` cookie apply where they should.
- Pin the tenant or domain with `requiredClaims` for multi-tenant IdPs (`hd`, `tid`).
- Keep `authn.linking.*` off unless you need it, and turn on per-provider switches only for IdPs that verify emails.

## Related

- [Login flow](01-login-flow.md): the order of the checks.
- [Provider HTTP client, discovery and keys](08-http-client.md): transport and key rules in detail.
- [`@spinajs/authn`](../authn/README.md): the opaque failure answer (A02) and the audit.
