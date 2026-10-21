# Policies

The package ships `@spinajs/http` policies that guard a controller or a route by the state of authentication: an authenticated caller, a fresh login, a passed second factor, no session, no per-request credential, no impersonation. Attach them with `@Policy`. They read `req.storage.AuthnPrincipal` and `req.storage.AuthnSession`, which [`AuthnMiddleware`](01-request-authentication.md) wrote.

They decide **who** may call, not **what** the caller may do. Permissions belong to [`@spinajs/authz-http`](../authz-http/README.md).

## How it works

1. `@Policy(...)` on a class adds a group to the controller scope, on a method to the route scope. One `@Policy([A, B])` is A AND B; stacked `@Policy` decorators are OR; the controller and route scopes are AND. See [Policies in `@spinajs/http`](../http/13-policies.md).
2. Per request, the policy gate calls `execute(req, route, controller)` on every policy of the route **in parallel**.
3. A policy throws to refuse. The error becomes the answer: 401 `{ "error": "unauthenticated", "message": ... }`, or 403 `{ "error": "<code>", "message": ... }`. Outside production the body also carries `stack` (see [Error handling](../http/11-error-handling.md)).

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Policy(Authenticated)` | class or method | | 401 `unauthenticated` unless `req.storage.AuthnPrincipal` is set and `authenticated: true`. A pending (pre-MFA) session has no principal and fails. |
| `@Policy(FreshAuth, maxAgeSeconds?)` | class or method | `maxAgeSeconds`: integer `>= 1`; default `authn.freshAuth.maxAgeSeconds`, read when the policy runs | Passes a session principal that logged in within `maxAgeSeconds`, or one that sends its password in the body field `reauthPassword`. See [Fresh authentication](#fresh-authentication). |
| `@Policy(MfaSatisfied)` | class or method | | 401 without a principal. Passes when `principal.authn.assurance` is `aal2`, or the MFA policy (`authn.mfa.policy.service`) requires no step for the principal. Otherwise 403 `mfa_required`. |
| `@Policy(NoSession)` | class or method | | 403 `session_exists` when the request restored any session, active or pending. |
| `@Policy(NotLoggedPolicy)` | class or method | | 403 `already_authenticated` when a principal exists. A pending session passes, so a half-finished login can start over. |
| `@Policy(NoTokenAuthPolicy)` | class or method | | 403 `session_required` when the principal came from a per-request credential (API token, JWT, key, signature): a principal without `authn.sessionHandle`. Anonymous passes. |
| `@Policy(NoImpersonationPolicy)` | class or method | | 403 `impersonating` while `principal.authn.impersonator` is set. Anonymous passes. |

`NoTokenAuthPolicy` and `NoImpersonationPolicy` pass an anonymous caller: combine them with `Authenticated`, as `@Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])`.

### Fresh authentication

`FreshAuth.execute()` and the exported function `assertFreshAuth(container, req, maxAgeSeconds?, password?)` run the same check:

1. No authenticated principal: 401 `unauthenticated`.
2. A principal that is not a session principal, or no active session: 403 `session_required`.
3. An impersonation: 403 `impersonating`. Impersonation is never fresh.
4. `principal.authn.authenticatedAt` within `maxAgeSeconds`: passes; `assertFreshAuth` returns `null`.
5. No password (missing or empty): 403 `fresh_auth_required`.
6. The password re-authenticates the session's identity with purpose `'reauth'`, counted in the `reauth` throttle. The login is the email from `IdentityStore.display(identity)`. A password over 1024 characters, an identity without an email, a wrong password or a throttled attempt: 401 with the [login failure body](17-answers-and-response-extensions.md#the-shared-401-body), without `Retry-After`.
7. Success: passes; `assertFreshAuth` returns the verified credentials.

`FreshAuth` takes the password with `takeReauthPassword(req)`: it removes `reauthPassword` from a plain-object `req.body` and drops `req.rawBody` before the route runs, so the password never reaches the action, a model or a request log.

With a `maxAgeSeconds` stricter than `authn.freshAuth.maxAgeSeconds`, the password is verified through `AuthnService.reauthenticate()`; otherwise through `FreshAuthCheck.check()` of `@spinajs/authn`.

An inline `reauthPassword` counts for that request only. [`POST /auth/reauth`](08-login-logout-and-mfa-routes.md#post-authreauth) refreshes the session's `authenticatedAt` instead, so the following requests pass step 4.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.freshAuth.maxAgeSeconds` | `integer` | `300` | `>= 1` | Default age of a fresh login for `FreshAuth` and `assertFreshAuth`. |
| `authn.mfa.policy.service` | `string` | `'DefaultMfaPolicy'` | name of a registered `MfaPolicy` | Policy `MfaSatisfied` asks. An unregistered name fails the request with `InvalidOption`. |

Both keys belong to [`@spinajs/authn`](../authn/13-configuration-and-boot-checks.md).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `Authenticated`, `NoSession`, `MfaSatisfied`, `NotLoggedPolicy`, `NoTokenAuthPolicy`, `NoImpersonationPolicy` | resolved by class from `@Policy`, default lifetime | the exported classes | | Subclass and `DI.register(Mine).as(Authenticated)` before `Controllers` resolves. |
| `FreshAuth` | `@NewInstance()`: one instance per route | the exported class | | As above. |
| `MfaPolicy` | named registration read from `authn.mfa.policy.service` | `DefaultMfaPolicy` from `@spinajs/authn` | your own | See [`@spinajs/authn`: MFA](../authn/04-mfa-policy-and-steps.md). |
| `FreshAuthCheck`, `AuthnService`, `IdentityStore` | resolved per call by `assertFreshAuth` | from `@spinajs/authn` and `@spinajs/users` | | See [`@spinajs/authn`](../authn/README.md). |

## Important behaviour

- **All policies of a route run at once.** A route that combines a group gate with `FreshAuth` would verify a password even while the gate answers 404. The package's own routes therefore run the check inside the handler (`freshAuthOrAnswer()`, over `assertFreshAuth()`, answering a failed re-authentication with the login failure body); do the same when a route has a gate policy.
- **`FreshAuth` passes only session principals.** A per-request credential always looks fresh, so it is refused.
- **`MfaSatisfied` treats an MFA policy refusal as `mfa_required`.** An enrolment the step list does not cover gives 403; any other policy error fails the request.
- **No policy, no check.** A route without `Authenticated` is open to anonymous callers.
- `FreshAuth` validates `maxAgeSeconds` in its constructor: a value that is not an integer `>= 1` fails at route registration.

## Best practices

- Put `@Policy(Authenticated)` on the controller and narrow single routes with `FreshAuth` or `MfaSatisfied`.
- Use `FreshAuth` for routes that hand out lasting credentials or change security settings; clients send `reauthPassword` when the answer is 403 `fresh_auth_required`.
- Use `[Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy]` for routes that manage credentials: an API token must not mint tokens, and an impersonator must not leave credentials behind.

## Patterns and antipatterns

```ts
// Don't: NoTokenAuthPolicy alone lets anonymous callers through
@Policy(NoTokenAuthPolicy)
@Post('export')
public async export() { /* ... */ }

// Do: require a session principal
@Policy([Authenticated, NoTokenAuthPolicy])
@Post('export')
public async export() { /* ... */ }
```

## Examples

### Require a recent login to delete a project

```ts sample
import '@spinajs/authn-http';
import { Authenticated, FreshAuth, Identity, MfaSatisfied } from '@spinajs/authn-http';
import type { AuthnIdentity } from '@spinajs/authn-http';
import { BaseController, BasePath, Del, Get, Ok, Param, Policy } from '@spinajs/http';

@BasePath('projects')
@Policy(Authenticated)
export class ProjectsController extends BaseController {
  @Get(':id')
  public async show(@Param() id: string) {
    return new Ok({ id });
  }

  /** A login within 10 minutes, or `reauthPassword` in the body, and a passed second factor. */
  @Del(':id')
  @Policy([FreshAuth, MfaSatisfied], 600)
  public async remove(@Param() id: string, @Identity() who: AuthnIdentity) {
    return new Ok({ id, removedBy: who.identity.id });
  }
}
```

`@Policy([FreshAuth, MfaSatisfied], 600)` passes `600` to the constructor of every policy in the group; `MfaSatisfied` ignores it.

## Related

- [Policies in `@spinajs/http`](../http/13-policies.md): groups, scopes and the policy gate.
- [Route arguments](06-route-arguments.md): read the caller inside the route.
- [Socket sessions](18-socket-sessions.md): the policies exported for socket controllers.
- [`@spinajs/authz-http`: protecting routes](../authz-http/01-protecting-routes.md): permission checks after authentication.
