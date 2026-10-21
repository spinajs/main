# RP-initiated logout

When a user signs out of your app, the identity provider (IdP) still has its own session, and the next "Sign in with ..." click logs the user straight back in. [OpenID Connect RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html) ends that session too: after the app revoked its own session, the browser goes to the provider's `end_session_endpoint`.

This is the browser-driven counterpart of [back-channel logout](11-backchannel-logout.md), which carries a sign-out in the other direction (IdP to app).

## How it works

`POST /auth/logout` of `@spinajs/authn-http` revokes the session, audits it and then runs every registered `AuthnLogoutExtension` (see [Login, logout and MFA routes](../authn-http/08-login-logout-and-mfa-routes.md#post-authlogout)). `@spinajs/authn-oidc` registers `OidcLogoutExtension`, which answers a redirect when all of these hold:

1. The session came from an OIDC login: `AuthnFacts.external.provider` is `oidc:<name>` of a configured provider. A password session, or a session from another kind of external login, gets no redirect and the logout answers as before.
2. The provider's discovery document advertises an `end_session_endpoint`. A plain OAuth2 provider (GitHub) has no discovery, and a value that is not an https URL (http in development and test) is ignored, so neither blocks a login.
3. Discovery is reachable. A failure is logged and the logout answers as before; the session is already revoked.

The redirect is the endpoint with these query parameters added to any it already has:

| Parameter | Value |
| --- | --- |
| `client_id` | The provider's `clientId` |
| `post_logout_redirect_uri` | `authn.oidc.providers.<name>.logout.postLogoutRedirectUri`, else `/` on the request's origin (resolved through `authn.http.trustProxy` as the default `redirect_uri` is) |
| `logout_hint` | The IdP session id (`sid` of the ID token), when the login had one |
| `id_token_hint` | The ID token of the login, when the session holds it (see below) |

The route answers by the kind of client, as the login callback does:

| Client | Answer |
| --- | --- |
| Browser navigation (`Sec-Fetch-Mode: navigate`, or `Accept` lists `text/html`) | `303` to the URL |
| Script (`fetch`, XHR) | `200 { "endSession": "<url>" }`; the script sets `location` itself |

Both carry the cleared session cookie, `Clear-Site-Data` and `Cache-Control: no-store`. The session is revoked before the redirect in every case, so the user is logged out of the app even if the provider is down.

### Keeping the ID token

Some providers require `id_token_hint` and refuse a logout request without it. With `logout.storeIdToken: true` the callback keeps the validated ID token in the session data under the key `OidcIdToken` (`OIDC_ID_TOKEN_KEY`), and the redirect carries it. The default is `false`: the token is a bearer proof of the login, and a session store (database rows, Redis keys) is a wider place to keep it than a request. Turn it on only for a provider that needs it. A session that cannot store the token (the store fails) keeps working and only loses the hint.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.oidc.providers.<name>.logout.storeIdToken` | boolean | `false` | | Keep the ID token in the session and send it as `id_token_hint`. |
| `authn.oidc.providers.<name>.logout.postLogoutRedirectUri` | string | `<origin>/` | absolute https URL without credentials or fragment; a query is allowed | Where the provider sends the browser after it ended its session. The provider must have it registered exactly. |

Any other key under `logout` fails validation. Register the `post_logout_redirect_uri` at the provider next to the callback URL; Keycloak calls it "Valid post logout redirect URIs".

## Services and extension points

| Class or function | Role |
| --- | --- |
| `AuthnLogoutExtension` (`@spinajs/authn-http`) | The extension point; register your own with `@Injectable(AuthnLogoutExtension)`. The first redirect any extension answers wins |
| `OidcLogoutExtension` | Built-in implementation; resolves the origin and calls `OidcRpLogout` |
| `OidcRpLogout` | Framework-free: `endSessionUrl(session, origin)` answers the URL or `undefined` |
| `OIDC_ID_TOKEN_KEY` | The session data key of the stored ID token; read it with `session.get(OIDC_ID_TOKEN_KEY)` |

## Important behaviour

- The redirect leaves the app, so an XHR logout must follow `endSession` itself. A form post follows the `303` on its own.
- Only a navigation request is redirected: a logout from a script that ignores `endSession` leaves the IdP session alive.
- `Clear-Site-Data: "cache", "cookies", "storage"` applies to the app's origin, not the provider's.

## Related

- [Login flow](01-login-flow.md): where the ID token is validated.
- [Back-channel logout](11-backchannel-logout.md): the IdP telling the app.
- [Provider configuration](02-provider-configuration.md#authnoidcprovidersname-logout): every key.
