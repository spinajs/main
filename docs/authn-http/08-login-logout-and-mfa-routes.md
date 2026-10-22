# Login, logout and MFA routes

`AuthnLoginController` and `AuthnMfaController` log a user in with a password, ask a pending session's step to send its code, complete a pending login with a second factor or a recovery code, report who is calling, and log out. They are always on. The password check runs in [`@spinajs/authn`](../authn/01-authentication-flow.md) and the strategy listed in `authn.strategies` (usually [`@spinajs/authn-local`](../authn-local/README.md)); the session comes from [`@spinajs/authn-session`](../authn-session/README.md).

Key login (`POST /auth/keys/login`) answers the same way, through the same `completeLogin()` helper; it is on [Key routes](15-key-routes.md). OIDC login is in [`@spinajs/authn-oidc`](../authn-oidc/01-login-flow.md#http-routes).

## How it works

### Password login

1. `POST /auth/login` reaches `AuthnLoginController.login()`. The route has no policy.
2. `login` and `password` are read from the JSON body, each a non-empty string of at most `PASSWORD_HARD_CAP` (1024, from `@spinajs/authn/contracts`) characters. The controller hands them, or `null` when either is missing or malformed, to `completeLogin()`, which runs the rest.
3. A session the caller already holds (active or pending) is revoked through `SessionIssuer.revoke()` and audited as `session.revoke`, reason `login`. Without credentials the answer is then 401 with the login failure body.
4. `AuthnService.authenticate({ kind: 'password', login, password }, ctx)` runs with purpose `'login'` and `ctx.ip` from `ClientIp`.
5. The result decides the answer:
   - `failure`: 401 login failure body, plus `Retry-After` when the reason is `throttled`. A revoked earlier session also gets its cookie cleared.
   - `mfa_required`: the pending session gets the client ip and user agent (`stampClient`), then **200** `{ "MfaRequired": ["totp"], "MfaEnrol": [] }` with the pending session cookie. `MfaEnrol` lists the steps of `MfaRequired` the identity has not enrolled in: a forced enrolment (`authn.mfa.policy.force`, `forceForRoles`) answers `"MfaEnrol": ["totp"]`, and the client enrols through [`POST /user/mfa`](13-mfa-enrolment-routes.md) before it verifies.
   - `success` without a session (a strategy that issues none): 401 login failure body.
   - `success`: the session gets the client ip and user agent, and the [`SessionStartHook`s](../authn/12-integration-hooks.md#sessionstarthook) are asked for its initial active role; then **200** with the [principal summary](17-answers-and-response-extensions.md#the-principal-summary) of the (narrowed) principal, extended by every `AuthnResponseExtension` with kind `login`, and the session cookie. `POST /auth/mfa/verify` and `/auth/mfa/recovery` ask the hooks the same way for the elevated session.

### MFA completion

1. `POST /auth/mfa/verify` or `POST /auth/mfa/recovery` reaches `AuthnMfaController.complete()` with the pending session cookie.
2. No session: 401 `unauthenticated`. An active session: 403 `mfa_not_pending`.
3. `code` is read from the body (at most 1024 characters). Missing: 401 login failure body.
4. The step: for `/mfa/recovery`, `recovery`. For `/mfa/verify`, `step` from the body when it is one of the pending steps, else the first pending step. The pending steps are those stored with the session, or, for a session without stored steps, the ones the MFA policy (`authn.mfa.policy.service`) requires. No step: 401 login failure body.
5. `AuthnService.completeMfa(handle, step, code, ctx)` runs with purpose `'login'`, counted in the `mfa` throttle.
6. Failure: 401 login failure body, plus `Retry-After` when throttled; the session stays pending. Success: the session is elevated to `aal2` under a **new id**, keeping its data; **200** with the principal summary (extension kind `mfa`) and the new session cookie.

```mermaid
sequenceDiagram
  participant B as Browser
  participant L as AuthnLoginController
  participant M as AuthnMfaController
  participant A as AuthnService
  participant S as SessionIssuer
  B->>L: POST /auth/login { login, password }
  L->>A: authenticate(password credentials, ctx login)
  A->>S: issue pending session
  A-->>L: mfa_required (pending, steps)
  L-->>B: 200 { MfaRequired: ["totp"], MfaEnrol: [] } + Set-Cookie ssid (pending)
  B->>M: POST /auth/mfa/verify { code } + Cookie ssid
  Note over B,M: AuthnMiddleware restored the pending session; no principal
  M->>A: completeMfa(pending handle, "totp", code, ctx)
  A->>S: elevate to aal2, new id
  A-->>M: success (session)
  M-->>B: 200 { Identity, Authn, ...extensions } + Set-Cookie ssid (new id)
  B->>L: GET /auth + Cookie ssid
  L-->>B: 200 { Identity, Authn, ...extensions }
  B->>L: POST /auth/logout + Cookie ssid
  L->>S: revoke(handle)
  L-->>B: 200, cleared cookie, Clear-Site-Data
```

## Routes

### `POST /auth/login`

| | |
| --- | --- |
| Request body | `{ "login": string, "password": string }` |
| 200 | Principal summary plus extensions, `Set-Cookie` with the session, `Cache-Control: no-store` |
| 200 (MFA) | `{ "MfaRequired": string[], "MfaEnrol": string[] }`, `Set-Cookie` with the pending session, `Cache-Control: no-store` |
| 401 | Login failure body; `Retry-After` when throttled |

### `POST /auth/logout`

| | |
| --- | --- |
| Request | the session cookie, active or pending |
| 200 | No data; the cookie cleared, `Clear-Site-Data` with the directives of `authn.http.logout.clearSiteData` (default `"cache", "cookies", "storage"`, no header for `[]`), `Cache-Control: no-store` |
| 200 (redirect) | `{ "endSession": string }` with the same cookie and headers, for a script when a logout extension named a redirect |
| 303 | The same headers and `Location`, for a browser navigation when a logout extension named a redirect |
| 401 | `unauthenticated`: no session |

Logout revokes the session (an impersonation ends with it), audits `logout`, and for an impersonation also `impersonation.end` with reason `logout`. It is `POST`, so no cross-site link can log anyone out, and the [CSRF origin guard](04-csrf-origin-guard.md) checks it.

After the revoke, every registered `AuthnLogoutExtension` runs in registration order, with the revoked `Session` and the request. The first redirect any of them answers wins; the others still run. A navigation request (`Sec-Fetch-Mode: navigate`, or `Accept` lists `text/html`) gets `303`, any other client `200 { endSession }`. An extension that throws is logged by name and skipped: the session is already revoked. `@spinajs/authn-oidc` registers one that ends the provider's session ([RP-initiated logout](../authn-oidc/12-rp-initiated-logout.md)).

```ts
import { Injectable } from '@spinajs/di';
import { AuthnLogoutExtension } from '@spinajs/authn-http';
import type { Session } from '@spinajs/authn/contracts';

@Injectable(AuthnLogoutExtension)
export class SignedOutPage extends AuthnLogoutExtension {
  public async afterLogout(session: Session) {
    return session.facts.method === 'saml' ? { redirect: 'https://sso.example.com/saml/logout' } : undefined;
  }
}
```

### `GET /auth` (whoami)

| | |
| --- | --- |
| 200 | Principal summary plus extensions (kind `whoami`), `Cache-Control: no-store` |
| 200 (pending) | `{ "MfaRequired": string[], "MfaEnrol": string[] }` for a pending session |
| 401 | `unauthenticated`: no principal and no pending session |

Works for any authenticated principal, including API tokens and keys.

### `POST /auth/mfa/verify`

| | |
| --- | --- |
| Request body | `{ "code": string, "step"?: string }` and the pending session cookie |
| 200 | Principal summary plus extensions (kind `mfa`), `Set-Cookie` with the new session id |
| 401 | `unauthenticated` without a session; login failure body for a missing or wrong code, `Retry-After` when throttled |
| 403 | `mfa_not_pending`: the session is already active |

### `POST /auth/mfa/recovery`

| | |
| --- | --- |
| Request body | `{ "code": string }`: a single-use recovery code |
| Answers | as `POST /auth/mfa/verify` |

### `POST /auth/mfa/step-up`

Raises an active `aal1` session to `aal2`, for a route behind `MfaSatisfied` that answered `403 mfa_required`. It calls `AuthnService.stepUp`.

| | |
| --- | --- |
| Request body | `{ "code": string, "step"?: string }` and the session cookie. `step` is a step the identity is enrolled in, or `recovery` for a recovery code. Without it, the first enrolled step of `authn.mfa.steps` is used |
| 200 | Principal summary plus extensions (kind `mfa`), `Set-Cookie` with the new session id. An `aal2` session keeps its id |
| 401 | `unauthenticated` without a session. Login failure body for a missing or wrong code, an impersonated session or no enrolled step, with `Retry-After` when throttled |
| 403 | `mfa_pending`: the session is pending; complete it with `POST /auth/mfa/verify` |

The CSRF guard checks it like any other request with the session cookie.

### `POST /auth/mfa/challenge`

For a step that delivers its code out of band, such as the [email code](../authn-local/15-email-codes.md): the client calls it after login answered `MfaRequired`, and the step mails the code. TOTP needs no challenge.

| | |
| --- | --- |
| Request body | `{ "step"?: string }`: a pending step, else the first pending step |
| 202 | `{ "Ok": true }`, `Cache-Control: no-store` |
| 401 | `unauthenticated` without a session |
| 403 | `mfa_not_pending`: the session is already active |

The pending session's identity is the one asked; the body names no identity. The answer is 202 whether the step has a `challenge`, whether it sent anything (an unenrolled, banned or throttled request sends nothing) and whether the send worked. A failing step is logged by its error name only. The step does its own throttling: a repeat inside the backoff sends no second mail.
### `POST /auth/reauth`

Re-authenticates the active session with its password and refreshes its `authenticatedAt`, so routes behind `FreshAuth` pass without `reauthPassword` for `authn.freshAuth.maxAgeSeconds`. It calls `AuthnService.reauthenticate` (purpose `reauth`, counted in the `reauth` throttle), then `SessionIssuer.reissue(h, { authenticatedAt: now })`. The session keeps its identity, assurance, MFA steps and data under a new id. `AuthnReauthController` serves it.

| | |
| --- | --- |
| Request body | `{ "password": string }` and the session cookie. The login is the email from `IdentityStore.display(identity)` |
| 200 | Principal summary plus extensions (kind `whoami`), `Set-Cookie` with the new session id. The old id is dead |
| 401 | `unauthenticated` without a session, or when the session ends meanwhile. Login failure body for a missing, over-long or wrong password and a throttled attempt, without `Retry-After`; the session stays as it was |
| 403 | `mfa_pending` for a pending session; `impersonating` during an impersonation |

A user who logs in through an OIDC provider re-authenticates with `GET /auth/oidc/:provider/reauth` instead ([`@spinajs/authn-oidc`](../authn-oidc/01-login-flow.md#re-authentication-get-authoidcproviderreauth)).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.strategies` | `{ name, service }[]` | `[]` | | Strategies `authenticate()` may use; see [`@spinajs/authn`](../authn/03-strategies.md). |
| `authn.mfa.policy.service` | `string` | `'DefaultMfaPolicy'` | registered `MfaPolicy` name | Asked for the pending steps of a session that stored none (`POST /auth/mfa/verify`, `GET /auth`). |
| `authn.http.logout.clearSiteData` | `string[]` | `['cache', 'cookies', 'storage']` | `cache`, `cookies`, `storage`, `executionContexts`, `*`, each once | The `Clear-Site-Data` directives of `POST /auth/logout`; `[]` sends no header. Another value fails the boot. |
| `authn.session.cookie` | object | | | Name and flags of the session cookie; see [`@spinajs/authn-session`](../authn-session/README.md). |
| `http.cookie.secret` | `string` | | | Signs the session cookie. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthnService` | resolved per call | `DefaultAuthnService` (`@spinajs/authn`) | | See [`@spinajs/authn`](../authn/README.md). |
| `SessionIssuer` | autoinjected | `DefaultSessionIssuer` (`@spinajs/authn-session`) | | See [`@spinajs/authn-session`](../authn-session/README.md). |
| `AuthnResponseExtension` | `Array.ofType`, every registered one runs | none here; `AccessResponseExtension` in `@spinajs/users` | your own | See [Answers and response extensions](17-answers-and-response-extensions.md). |

## Important behaviour

- **One answer for every failure.** Unknown login, wrong password, inactive or banned account, over-long fields and a missing body all answer the same 401 body. The real reason goes to the audit only.
- **Logging in ends the held session.** A second login on the same browser revokes the first session, even an active one; the route has no `NotLoggedPolicy`.
- **A pending session answers only `MfaRequired` and `MfaEnrol`.** `GET /auth` reveals no identity until the second factor passed. `MfaEnrol` empties once the pending session has enrolled the step, and it then verifies as any other.
- **MFA success rotates the session id.** The pending cookie stops working; the answer carries the new one. A step-up does the same to the `aal1` cookie.
- **The client ip and user agent are stored** with each new session (user agent cut to 512 characters); `GET /user/sessions` shows them.
- **The cookie is a browser-session cookie** with no max-age; the server enforces idle and total lifetime.
- **Logout clears the browser storage of the origin by default.** `"storage"` removes localStorage, sessionStorage and IndexedDB, including preferences an app keeps across sessions (theme, saved filters). Leave it out of `authn.http.logout.clearSiteData` only when that data holds nothing about the user: on a shared machine the next person sees what stays.

## Best practices

- Send `credentials: 'include'` (or the equivalent) from browser clients and read `MfaRequired` before treating a 200 from `POST /auth/login` as a finished login.
- Retry a 401 that carries `Retry-After` only after that many seconds; earlier attempts are refused without being checked.
- Call `GET /auth` at app start to restore the signed-in state instead of storing it on the client.

## Patterns and antipatterns

```ts
// Don't: a 200 from login is not always a finished login
const res = await fetch('/auth/login', { method: 'POST', body, headers, credentials: 'include' });
if (res.ok) showDashboard();

// Do: a pending login asks for the second factor, or to enrol it first
const answer = await res.json();
if (answer.MfaEnrol?.length) startEnrolment(answer.MfaEnrol);
else if (answer.MfaRequired) askForCode(answer.MfaRequired);
else if (res.ok) showDashboard();
```

## Related

- [Action hooks](23-action-hooks.md): `POST /auth/logout` runs `authn.logout`; a refusal answers 403 `{ error: 'action_refused', code }` and keeps the session and the cookie.
- [`@spinajs/authn`: how a login runs](../authn/01-authentication-flow.md): the steps inside `authenticate()` and `completeMfa()`.
- [`@spinajs/authn`: MFA](../authn/04-mfa-policy-and-steps.md): MFA policy and steps.
- [`@spinajs/authn-totp`](../authn-totp/README.md): the TOTP step; enrol it with the [MFA enrolment routes](13-mfa-enrolment-routes.md).
- [Session management routes](09-session-management-routes.md): list and end sessions.
- [Answers and response extensions](17-answers-and-response-extensions.md): the answer body and its extensions.
