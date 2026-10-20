# `@spinajs/authn-http`

The HTTP layer of SpinaJS authentication. It finds the caller of every request (session cookie, API token, JWT, key assertion or HTTP signature), stores the result in `req.storage.AuthnPrincipal`, guards routes with policies, and mounts the login, MFA, session, password, token, key, impersonation and credential admin routes.

It does **not** verify credentials, issue sessions or decide permissions. Verification runs in [`@spinajs/authn`](../authn/README.md) and its strategy packages, sessions in [`@spinajs/authn-session`](../authn-session/README.md), and authorization in [`@spinajs/authz-http`](../authz-http/README.md), which reads the principal this package leaves on the request.

## Install

```sh
npm install @spinajs/authn-http
```

Import the package in the app entry, **before** anything resolves `Controllers` or `HttpServer`. Loading it registers the middleware, the credential extractors, the principal resolvers and the route arguments on the root container. Its shipped config adds the route controllers and the `authn:check-config` command to the directory scan. See [Request authentication](01-request-authentication.md#setup-and-load-order).

## Features

| Feature | What it does |
| --- | --- |
| [Request authentication](01-request-authentication.md) | `ClientIp` and `AuthnMiddleware`: restore the session cookie, extract credentials, resolve `req.storage.AuthnPrincipal`. |
| [Credential extractors](02-credential-extractors.md) | Turn `Authorization`, `x-api-key` and signature headers into credentials; add your own. |
| [Principal resolvers](03-principal-resolvers.md) | Turn credentials or a session into a principal, in order; add your own. |
| [CSRF origin guard](04-csrf-origin-guard.md) | `CsrfOriginGuard`: refuses cross-origin unsafe requests that carry the session cookie. |
| [Policies](05-policies.md) | `Authenticated`, `FreshAuth`, `MfaSatisfied`, `NoSession` and the other route guards. |
| [Route arguments](06-route-arguments.md) | `@Identity()`, `@AuthnSession()`, `@SessionId()` and `@FromSession(key)`. |
| [Route groups](07-route-groups.md) | Every route the package mounts, the service that switches each group on, and the shared answers. |
| [Login, logout and MFA routes](08-login-logout-and-mfa-routes.md) | `POST /auth/login`, `POST /auth/logout`, `GET /auth`, `POST /auth/mfa/verify`, `POST /auth/mfa/recovery`. |
| [Session management routes](09-session-management-routes.md) | List and end the caller's own sessions under `/user/sessions`. |
| [Active role routes](10-active-role-routes.md) | Narrow a session to one role it holds under `/auth/active-role`. |
| [Impersonation routes](11-impersonation-routes.md) | Start, inspect and stop impersonation under `/auth/impersonate`. |
| [Password routes](12-password-routes.md) | Password policy, reset request, reset and change. |
| [MFA enrolment routes](13-mfa-enrolment-routes.md) | Enrol, confirm and disable TOTP, regenerate recovery codes under `/user/mfa`. |
| [API token routes](14-api-token-routes.md) | List, create and revoke the caller's API tokens under `/user/tokens`. |
| [Key routes](15-key-routes.md) | Register and revoke public keys, issue challenges, log in with a key. |
| [Credential admin routes](16-credential-admin-routes.md) | Reset another user's password or TOTP, end their sessions, revoke their tokens. |
| [Answers and response extensions](17-answers-and-response-extensions.md) | The principal summary, `AuthnResponseExtension`, the shared 401 body and the session cookie helpers. |
| [Socket sessions](18-socket-sessions.md) | `@spinajs/authn-http/socket`: the session cookie as an `http-socket` principal source. |
| [`authn:check-config` command](19-check-config-command.md) | Reports what the `authn.*` configuration gets wrong. |

## Quick start

```ts sample
import '@spinajs/authn-http';
import { Authenticated, Identity } from '@spinajs/authn-http';
import type { AuthnIdentity } from '@spinajs/authn-http';
import { BaseController, BasePath, Get, Ok, Policy } from '@spinajs/http';

@BasePath('profile')
@Policy(Authenticated)
export class ProfileController extends BaseController {
  @Get('/')
  public async me(@Identity() who: AuthnIdentity) {
    return new Ok({ id: who.identity.id, method: who.facts.method, assurance: who.facts.assurance });
  }
}
```

The route answers 401 to an anonymous caller and to a session still waiting for its second factor.

## Related packages

- [`@spinajs/authn`](../authn/README.md): `AuthnService`, the contracts (`CredentialExtractor`, `SessionIssuer`, `AuthnResponseExtension`, ...) and the `authn.*` config schema this package reads.
- [`@spinajs/authn-session`](../authn-session/README.md): the session issuer and the session cookie that `AuthnMiddleware` restores.
- [`@spinajs/authn-local`](../authn-local/README.md): the password strategy behind `POST /auth/login` and the `PasswordService` that switches the password routes on.
- [`@spinajs/authn-token`](../authn-token/README.md): API tokens and JWT bearers; its `TokenService` switches the token routes on.
- [`@spinajs/authn-keys`](../authn-keys/README.md): key assertions, HTTP signatures and challenge login; its `KeyRegistry` switches the key routes on.
- [`@spinajs/authn-totp`](../authn-totp/README.md): the TOTP step and `TotpService` behind the MFA enrolment routes.
- [`@spinajs/authn-oidc`](../authn-oidc/README.md): OIDC login routes built on this package's 401 body and cookie helpers.
- [`@spinajs/authz-http`](../authz-http/README.md): turns `req.storage.AuthnPrincipal` into the authorization principal.
- [`@spinajs/users`](../users/README.md): the identity store, `RoleSource`, `ImpersonationGuard`, `CredentialAdminGuard` and the `Access` answer extension.
- [`@spinajs/http`](../http/README.md): server middlewares, policies, route arguments and responses this package builds on.
- [`@spinajs/http-socket`](../http-socket/README.md): socket principal sources; see [Socket sessions](18-socket-sessions.md).
