# Request authentication

Three server middlewares find the caller of every request: `ClientIp` (order 2), [`CsrfOriginGuard`](04-csrf-origin-guard.md) (order 4) and `AuthnMiddleware` (order 5). `AuthnRealIp` (order 1) resolves the client address they use, the same one `@RateLimit` and `http.throttle` count. They leave the restored session in `req.storage.AuthnSession` and the authenticated principal, or `null`, in `req.storage.AuthnPrincipal`. Routes read these through [policies](05-policies.md) and [route arguments](06-route-arguments.md); [`@spinajs/authz-http`](../authz-http/README.md) reads the principal for authorization.

## How it works

1. **`AuthnRealIp.onBefore()`**, registered over http's `RealIp`, writes `req.storage.realIp`: the socket address, or the client address behind trusted proxy hops only. Trust comes from `authn.http.trustProxy`, else `http.trustProxy` (through `proxyTrustOf()`). **`ClientIp.onBefore()`** copies it into `req.storage.ClientIp`. Every `AuthnContext.ip` the package builds comes from this value, never from Express's `req.ip`, so `@IpThrottle`, the authn services, the audit log, `@RateLimit` and `http.throttle` all count one client address. See [Client IP](../http/17-client-ip-and-trust-proxy.md#one-client-address-with-authn).
2. **`CsrfOriginGuard.onBefore()`** refuses a cross-origin unsafe request from a browser, or one that carries the session cookie, with 403, before any authentication. See [CSRF origin guard](04-csrf-origin-guard.md).
3. **`AuthnMiddleware.authenticate()`** sets `req.storage.AuthnSession` and `req.storage.AuthnPrincipal` to `null`, then builds an `AuthnContext` with `contextOf(req, 'request')`: `ip` from `req.storage.ClientIp` and `userAgent`, each only when it is a string, `now` and purpose `'request'`.
4. **`AuthnMiddleware.restoreSession()`** reads the session cookie (name from `authn.session.cookie`, see [`@spinajs/authn-session`](../authn-session/README.md)):
   - a raw cookie in `req.cookies` is unsigned with `http.cookie.secret` (`cookie-signature`);
   - an Express `s:`-signed cookie is taken from `req.signedCookies`;
   - a bad signature logs a warning with a hashed value and restores nothing;
   - a valid id goes to `SessionIssuer.restore(id)`; an unknown or expired id logs a warning and restores nothing.

   The result, active or pending, goes to `req.storage.AuthnSession`. A restored session sets `Cache-Control: no-store`.
5. **`AuthnMiddleware.extract()`** runs only without an active session: an active session ignores bearer and signature headers. A repeated `Authorization`, `Proxy-Authorization` or `authn.token.headerName` header answers 400 here. It builds a `SignedRequest` (method, origin-form target, headers from `req.rawHeaders`, body on demand) and asks the [credential extractors](02-credential-extractors.md) in ascending `order`. The first non-null answer is the credentials.
6. **`AuthnMiddleware.principalOf()`** asks the [principal resolvers](03-principal-resolvers.md) in ascending `order`: `KeyPrincipalResolver` (45), `TokenPrincipalResolver` (50), `SessionPrincipalResolver` (100). The first answer that is not `undefined` wins, `null` included; all `undefined` gives `null`.
7. The answer goes to `req.storage.AuthnPrincipal`. A principal sets `Cache-Control: no-store`. An active session that gave no principal (revoked, expired, refused account) is dropped from `req.storage.AuthnSession`, so no route acts on it.
   With `authn.http.hooks.request` set to `true`, **`AuthnMiddleware.hookRequest()`** then runs the `authn.request` [action hooks](23-action-hooks.md) with a frozen copy of the principal (or `null`), the method, the path without its query string and the client ip. A refusal, or a hook that failed, answers 403 `{ error: 'action_refused', code }`.
8. Any store or resolver error rejects `onBefore` and fails the request (500) through the `@spinajs/http` global error answer. The request never continues as anonymous after an error.
9. `PrincipalMiddleware` of `@spinajs/authz-http` (order 10) runs next and copies `req.storage.AuthnPrincipal` into the authorization principal through its `AuthnPrincipalSource`; see [Principal resolution](../authz-http/03-principal-resolution.md).

```mermaid
sequenceDiagram
  participant C as Client
  participant IP as AuthnRealIp (1), ClientIp (2)
  participant G as CsrfOriginGuard (4)
  participant M as AuthnMiddleware (5)
  participant S as SessionIssuer
  participant X as CredentialExtractors
  participant R as AuthnPrincipalResolvers
  participant Z as authz-http PrincipalMiddleware (10)
  participant A as Controller route
  C->>IP: request (cookie and/or Authorization)
  IP->>IP: req.storage.realIp = ClientIp, from trusted proxies
  IP->>G: next()
  G->>G: unsafe method + session cookie? check Origin
  G-->>C: 403 E_CSRF_ORIGIN (cross-origin)
  G->>M: next()
  M->>S: restore(unsigned cookie id)
  S-->>M: Session (active or pending) or null
  M->>M: req.storage.AuthnSession = session
  alt no active session
    M->>X: extract(SignedRequest), ascending order
    X-->>M: first non-null Credentials
  end
  M->>R: resolve(req, credentials, ctx), ascending order
  R-->>M: first answer that is not undefined
  M->>M: req.storage.AuthnPrincipal = principal or null
  opt authn.http.hooks.request is true
    M->>M: authn.request action hooks
    M-->>C: 403 action_refused (refused)
  end
  M->>Z: next()
  Z->>Z: req.storage.Principal from AuthnPrincipal
  Z->>A: policies (Authenticated, ...), then the action
```

## Setup and load order

1. Import `@spinajs/authn-http` in the app entry. Loading `v3/register.js` imports `@spinajs/authn` (its root registers `AuthnService`, the MFA policy, the throttle and the other core services) and registers on the root container:
   - `AuthnMiddleware` as `ServerMiddleware`;
   - `HttpSignatureExtractor`, `AuthorizationBearerExtractor`, `ApiKeyHeaderExtractor` as `CredentialExtractor`;
   - `KeyPrincipalResolver`, `TokenPrincipalResolver`, `SessionPrincipalResolver` as `AuthnPrincipalResolver`;
   - the route argument classes `AuthnIdentityArg`, `AuthnSessionArg`, `AuthnSessionIdArg`, `AuthnSessionDataArg`.
2. `ClientIp` and `CsrfOriginGuard` register themselves with `@Injectable(ServerMiddleware)` when their modules load, which the package entry does. `registerAuthnHttpV3()` registers `AuthnRealIp` as `RealIp`, so the server mounts it in `RealIp`'s place.
3. The shipped config file adds `lib/v3/controllers` and `lib/cli` under `node_modules/@spinajs/authn-http` (resolved against `WORKSPACE_ROOT_PATH`, else the working directory) to `system.dirs.controllers` and `system.dirs.cli`. The route controllers load only through that scan; importing the package loads none of them.
4. A session issuer must be registered, from [`@spinajs/authn-session`](../authn-session/README.md): `AuthnMiddleware` autoinjects `SessionIssuer`.
5. A cookie parser must fill `req.cookies`. `@spinajs/http` mounts `CookieParserMiddleware` (Order 0.5) unless `http.bodyParsers.cookies.enabled` is `false`; see [Cookies](../http/20-cookies.md).

`HttpServer` fixes its middleware list when it is constructed, and `Controllers` constructs it before scanning the controller directories. When the package loads after that (for example only through the controller scan), `AuthnMiddleware` misses the pipeline and no request is authenticated. The package then logs an error on the `authn-http` logger that names the fix.

The same holds for `RealIp`: `@spinajs/http-socket`'s `SocketServer` resolves it when it starts and keeps that instance. When the package loads after `RealIp` was resolved, the kept instance is the plain `RealIp`, which ignores `authn.http.trustProxy`, so sockets and requests can see different client addresses. The package logs an error naming the fix: import `@spinajs/authn-http` before the socket server starts.

`registerAuthnHttpV3(container?)` repeats the registration for another container. It is idempotent; tests call it for a child container that holds their fakes. An app does not need to call it.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.http.trustProxy` | `string[]` or `integer` or `null` | unset | CIDR or address list, hop count `>= 0`, `null` | Proxies `AuthnRealIp` trusts for `X-Forwarded-For`, for every reader of the client address. `null` or unset falls back to `http.trustProxy`; `0` trusts no proxy. `true` coerces to 1 hop, `false` to 0. Set together with a different `http.trustProxy`, it wins and the boot warns. |
| `http.trustProxy` | see [Client IP](../http/17-client-ip-and-trust-proxy.md#configuration) | | | Used when `authn.http.trustProxy` is `null` or unset. Prefer setting only this key. |
| `authn.throttle.ipv6Prefix` | `integer` | unset | 16 to 128 | The IPv6 prefix of authn's ip keys (`@IpThrottle`, the services). Unset: `http.throttle.ipv6Prefix`, else 64. Set to a value other than that, the boot warns. See [Throttling](../authn/05-throttling.md). |
| `authn.http.publicOrigin` | `string` or `null` | unset | `scheme://host[:port]` | The app's public origin, never taken from `Host`: the origin clients put in an HTTP signature's `@target-uri`, and the origin of `@spinajs/authn-oidc`'s default `redirect_uri` and `post_logout_redirect_uri`. Unset: signed requests get no principal, and `AuthnMiddleware` warns at boot. |
| `authn.http.hooks.request` | `boolean` | `false` | `true`, `false` | Runs the `authn.request` [action hooks](23-action-hooks.md) on every request once its principal is resolved; a refusal answers 403 `{ code }`. Any value but `true` is off. |
| `http.cookie.secret` | `string` | `@spinajs/http` default | your own secret | Verifies the session cookie signature. Missing: boot fails. The public default: boot fails outside development and test, warns inside them. |
| `authn.session.cookie` | object | see [Session cookie](../authn-session/07-session-cookie.md) | | Cookie name and flags; `AuthnMiddleware` reads the name through `sessionCookieName()`. |

The authn routes have no prefix of their own: `http.controllers.route.prefix` moves them with every other controller.

```ts
export default {
  http: {
    cookie: { secret: process.env.COOKIE_SECRET },
  },
  authn: {
    http: {
      // Behind one reverse proxy.
      trustProxy: 1,
      // Needed only for HTTP message signatures.
      publicOrigin: 'https://api.example.com',
    },
  },
};
```

A `trustProxy` entry that is no address or CIDR, and a malformed `publicOrigin`, fail when the middleware is built, naming the key.

`authn.http.trustProxy` and `http.trustProxy` both set to different values, or an `authn.throttle.ipv6Prefix` other than the http one, each log one warning on the `authn-boot` logger at boot and show in `authn:check-config`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthnRealIp` | `RealIp` of `@spinajs/http`, registered by `registerAuthnHttpV3()` at package load, `Order` 1 | `AuthnRealIp` | | Subclass and `DI.register(MyRealIp).as(RealIp)` before `HttpServer` and `SocketServer` resolve; `@spinajs/http-socket` takes the handshake address from it too. Subclass `AuthnRealIp`, not `RealIp`: another `RealIp` ignores `authn.http.trustProxy`, so `ClientIp` fails the boot when that key is set and warns otherwise (`realIpOverrideFinding()`, also in `authn:check-config`). |
| `ClientIp` | `ServerMiddleware` list, `@Injectable(ServerMiddleware)`, `Order` 2, after any `RealIp` | `ClientIp` | | Kept for `req.storage.ClientIp`; change the address in `AuthnRealIp` instead, so every limiter sees it. |
| `AuthnMiddleware` | `ServerMiddleware` list, registered by `registerAuthnHttpV3()` at package load, `Order` 5 | `AuthnMiddleware` | | Prefer adding an [extractor](02-credential-extractors.md) or a [resolver](03-principal-resolvers.md). Protected `authenticate()`, `restoreSession()`, `extract()`, `principalOf()` and `hookRequest()` can be overridden in a subclass registered `.as(AuthnMiddleware)` before `HttpServer` resolves. |
| `SessionIssuer` | autoinjected by `AuthnMiddleware` | `DefaultSessionIssuer` from `@spinajs/authn-session` | | See [`@spinajs/authn-session`](../authn-session/README.md). |
| `CredentialExtractor` | `Array.ofType`, sorted by `order` once in `AuthnMiddleware.resolve()` | three shipped extractors | your own | See [Credential extractors](02-credential-extractors.md). |
| `AuthnPrincipalResolver` | `Array.ofType`, sorted by `order` once in `AuthnMiddleware.resolve()` | three shipped resolvers | your own | See [Principal resolvers](03-principal-resolvers.md). |

The package augments `IActionLocalStoregeContext` of `@spinajs/http` with:

| Field | Written by | Meaning |
| --- | --- | --- |
| `ClientIp?: string` | `ClientIp` | `req.storage.realIp`: the client address from the trusted proxy chain. Without one, the socket address. |
| `AuthnSession?: Session \| null` | `AuthnMiddleware` | The restored session, pending included; `null` without one. A session here is not authentication. |
| `AuthnPrincipal?: Principal \| null` | `AuthnMiddleware` | The authenticated principal; `null` for anonymous, a pending session or rejected credentials. |

## Important behaviour

- **A pending session is not authentication.** A session waiting for its second factor sets `AuthnSession` but yields no principal, so `Authenticated` fails. With a pending session, bearer credentials are still tried.
- **An active session wins over headers.** With an active session cookie, `Authorization`, `x-api-key` and signature headers are not read.
- **A bad credential never falls through.** A resolver that recognises its credentials answers `null` on failure and resolution stops; no other credential or session is tried.
- **No cookie is re-sent on authenticated requests.** The cookie is a browser-session cookie; the issuer slides the idle expiry server side.
- **A repeated credential header answers 400.** `Authorization`, `Proxy-Authorization` and the `authn.token.headerName` header are singleton fields (RFC 9110 §11.6.2). Sent more than once, `extract()` throws `CodedHttpException(400, 'E_REPEATED_CREDENTIAL_HEADER', 'the <name> header was sent more than once')`, before any extractor runs. The client gets that `{ code, message }` as JSON, with no stack and whatever its `Accept`; the http error handler still logs the error at error level. No strategy runs, no failure is counted, and no other header is tried. The request never reaches the route. With an active session no credential header is read, so it is not refused.
- **Other repeated headers are joined.** Headers come from `req.rawHeaders`, so a header sent on several lines (`Signature`, a field a signature covers) reaches the extractors as `a, b`, the value RFC 9421 §2.1 signs.
- **Raw secrets stay out of logs.** Cookie values and session ids are logged only as a domain-separated sha256, cut to 16 hex characters.
- **Anonymous answers stay cacheable.** `Cache-Control: no-store` is set only when a session or a principal was found.
- Extractors and resolvers are sorted once, when `AuthnMiddleware` resolves; one registered later is not used.

## Best practices

- Set `http.trustProxy` (or `authn.http.trustProxy`, not both) behind a proxy. Without it every client shares the proxy's address, and the login throttle and every rate limit key on that one address.
- Read the caller with [`@Identity()`](06-route-arguments.md) or `req.storage.AuthnPrincipal`, never with `req.storage.AuthnSession`: a pending session is present there too.
- Keep authorization decisions in [`@spinajs/authz-http`](../authz-http/README.md); this package answers only "who is calling".

## Patterns and antipatterns

```ts
// Don't: a pending (pre-MFA) session passes this check
if (req.storage.AuthnSession) {
  return new Ok(await loadInvoices());
}

// Do: only an authenticated principal counts
@Policy(Authenticated)
@Get('invoices')
public async invoices() {
  return new Ok(await loadInvoices());
}
```

## Examples

### Log every signed-in request with its client address

```ts sample
import '@spinajs/authn-http';
import { ServerMiddleware } from '@spinajs/http';
import type { IFinishContext } from '@spinajs/http';
import { Injectable } from '@spinajs/di';

@Injectable(ServerMiddleware)
export class SignedInAccessLog extends ServerMiddleware {
  constructor() {
    super();
    // After AuthnMiddleware (5): a request it refused never enters this one.
    this.Order = 6;
  }

  public onFinish({ req, res, storage, aborted }: IFinishContext): void {
    const principal = storage.AuthnPrincipal;
    if (principal) console.log(`${principal.type}:${principal.id} from ${storage.ClientIp} ${req.method} ${req.originalUrl} ${aborted ? 'aborted' : res.statusCode}`);
  }
}
```

## Related

- [Server middlewares](../http/15-server-middlewares.md): how `Order` places `ClientIp`, `CsrfOriginGuard` and `AuthnMiddleware` among the `@spinajs/http` middlewares.
- [Client IP and trusted proxies](../http/17-client-ip-and-trust-proxy.md): the `http.trustProxy` setting and `trustedClientAddress()`.
- [`@spinajs/authn`: how a login runs](../authn/01-authentication-flow.md): what `AuthnService.authenticate()` does with the credentials.
- [`@spinajs/authn`: principal and authorization](../authn/07-principal-and-authz.md): the principal shape and how it reaches authz.
- [`@spinajs/authn-session`](../authn-session/README.md): the cookie, the issuer and session expiry.
- [`@spinajs/authz-http`: principal resolution](../authz-http/03-principal-resolution.md): `PrincipalMiddleware` and `AuthnPrincipalSource`, which consume `req.storage.AuthnPrincipal`.
