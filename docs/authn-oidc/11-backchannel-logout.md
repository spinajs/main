# Back-channel logout

When a user signs out at the identity provider, the provider calls the app server to server, and the app ends the sessions that came from that IdP session. This is [OpenID Connect Back-Channel Logout 1.0](https://openid.net/specs/openid-connect-backchannel-1_0.html). No browser is involved and no cookie travels.

## How it works

### The route, `POST /auth/oidc/:provider/backchannel-logout`

The provider posts an `application/x-www-form-urlencoded` body with one member, `logout_token`, a JWT signed with a key of the provider's JWKS. `OidcController` hands the body to `OidcBackchannelLogout.receive()`:

1. The provider must be configured with an `issuer`: the token is checked against the JWKS that discovery names (`jwks_uri`). A plain OAuth2 provider (GitHub) has no keys, so its route answers 400.
2. `validateLogoutToken()` checks the token (next section).
3. The token's `jti` is claimed once in the `NonceStore` until the token expires. A replayed token answers 400.
4. With a `sid`, `SessionIssuer.revokeByExternal('oidc:<name>', sid)` ends every session issued from a login whose ID token carried that `sid`. With only a `sub`, the identity linked to `(oidc:<name>, sub)` loses every session, impersonations included (`revokeAll`).
5. The answer is `200` with `Cache-Control: no-store` and no body, also when no session matched. Any failure answers `400` with `{ "error": "invalid_request" }` (section 2.8).

### Token checks

| Check | Refused when |
| --- | --- |
| Signature | Not a compact JWS, an algorithm outside the provider's `algorithms`, a `crit` header, no JWKS key fits, or the signature does not verify |
| `typ` header | Present and not `JWT` or `logout+jwt`, so an access token cannot pass |
| `iss` | Not the provider's `issuer` or one of its `issuerAliases` |
| `aud` | Missing, or any audience other than the `clientId` |
| `iat` | Missing, or later than now plus `clockSkewSeconds` |
| `exp` | Not a number, or past (with the skew). A token without `exp` is accepted for five minutes after `iat` |
| `events` | No member `http://schemas.openid.net/event/backchannel-logout` holding an object |
| `nonce` | Present: an ID token never passes as a logout token |
| `jti` | Missing, or already claimed |
| `sub`, `sid` | Neither present, or one that is not a non-empty string of at most 255 characters |

### How a session knows its IdP session

At login, `mapClaims()` copies the ID token's `sid` claim onto the external subject (`ExternalSubject.sid`). `AuthnService` stores `AuthnFacts.external = { provider, sid }` in the session facts, and `DefaultSessionIssuer` gives the stored row `ExternalKey = sha256(provider + NUL + sid)`. The key survives the MFA step, rotations and elevation. Every shipped store indexes it:

| Store | Index |
| --- | --- |
| `MemorySessionStore` | Scans its map |
| `DbSessionStore` | Column `ExternalKey` with index `user_sessions_external_key_idx` (migration `UserSessionExternalKey_2026_10_21_00_01_00`) |
| `RedisSessionStore` | Set `session:external:<ExternalKey>` |
| `DynamoDbSessionProvider` | Attribute `ExternalKey`, read with a strongly consistent Scan like the subject lookups |

A session from a login without `sid`, or from before this release, has no key; only a `sub` logout token reaches it.

## Configuration

Nothing to configure in the app. Register the URL at the provider:

```text
https://<your host>/auth/oidc/<provider>/backchannel-logout
```

Keycloak calls it "Backchannel logout URL" (keep "Backchannel logout session required" on, so tokens carry `sid`). Auth0, Okta and Entra ID use the same spec. The provider must reach the app; the route needs no session and the CSRF guard of `@spinajs/authn-http` does not apply to it, since the request has no session cookie.

## Services and extension points

| Class or function | Role |
| --- | --- |
| `OidcBackchannelLogout` (internal, `src/token/logout-token.ts`) | Validates, claims the `jti` and revokes; `OidcController` builds it with the providers, the `SessionIssuer`, the `IdentityLinkStore` and the `NonceStore` |
| `validateLogoutToken(token, jwks, rules)` (internal) | The checks above; throws `AuthenticationFailed` naming the check |
| `SessionIssuer.revokeByExternal(provider, sid)` | Ends the sessions of one IdP session; answers the count |
| `SessionProvider.deleteByExternalKey(externalKey)` | The store side. A custom store must implement it (breaking change for third-party stores) |

## Important behaviour

- The answer never says whether a session matched: an unknown `sid` answers 200, as the spec asks.
- The `jti` is claimed before the revocation, so after a store failure (400) a retry with the same token answers 400 as a replay; a retry needs a fresh token.
- The `sub` path uses the link store, so it finds the identity only when the provider's `claims.subject` is `sub`.
- The issuer refuses a `provider` or `sid` longer than 255 characters and answers 0.

## Related

- [Login flow](01-login-flow.md): where the session and its facts are issued.
- [Security guarantees](09-security.md): the ID token checks the logout token checks mirror.
- [`@spinajs/authn-session`: revocation](../authn-session/02-revocation-and-session-list.md).
