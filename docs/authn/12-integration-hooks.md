# Integration hooks

Small contracts through which an app, `@spinajs/users` or `@spinajs/authn-http` plug into the authentication flow without authn importing them. Each is an abstract class you register with `@Injectable(<Hook>)`.

To run code around a login, an MFA completion, the start of a session, a step-up, an impersonation or an account link (to refuse it, change its attributes or observe its result) register an `ActionHook` instead: see [Action hooks](14-action-hooks.md) and [`@spinajs/hooks`](../hooks/README.md). `authn.login.identified` replaces the `ExternalLoginHook` of 3.0, and `authn.session.start` the `SessionStartHook` of 3.0.2 ([migration](14-action-hooks.md#sessionstarthook-is-removed)).

| Hook | Called by | Resolved as | Shipped implementation |
| --- | --- | --- | --- |
| `AuthnResponseExtension` | `@spinajs/authn-http`, when it builds an answer | Every registration | `AccessResponseExtension` (users) |
| `RoleSource` | `DefaultMfaPolicy` (`forceForRoles`), `@spinajs/authn-http` (role switch) | One, optional | `RbacRoleSource` (users) |
| `CredentialExtractor` | `@spinajs/authn-http`'s `AuthnMiddleware` | Every registration, by `order` | The extractors of `@spinajs/authn-http` |
| `ImpersonationGuard` | `AuthnImpersonationService`, on every request of an impersonation session; the start is checked by before hooks on `authn.impersonation.start` | One, optional | `AuthzImpersonationGuard` (users); see [Impersonation](11-impersonation-and-active-role.md) |

## `AuthnResponseExtension`

`extend(kind, principal, body)` adds fields to an answer `@spinajs/authn-http` is building. `kind` is `login`, `mfa`, `role-switch`, `impersonation` or `whoami`. `@spinajs/users` registers `AccessResponseExtension`, which adds `Access`.

```ts sample
import { Injectable } from '@spinajs/di';
import { AuthnResponseExtension } from '@spinajs/authn';
import type { Principal } from '@spinajs/authn';

@Injectable(AuthnResponseExtension)
export class AssuranceResponseExtension extends AuthnResponseExtension {
  async extend(kind: 'login' | 'mfa' | 'role-switch' | 'impersonation' | 'whoami', principal: Principal, body: Record<string, unknown>): Promise<void> {
    if (kind === 'login' || kind === 'mfa' || kind === 'whoami') body.SecondFactor = principal.authn?.assurance === 'aal2';
  }
}
```

## `RoleSource`

`rolesOf(principal)` returns `{ role, requirePassword }[]`: the roles the principal may switch to, and whether the switch asks for the password. Without a registration the role switch is off, and `authn.mfa.policy.forceForRoles` fails the boot. `@spinajs/users` registers `RbacRoleSource` over the RBAC summary.

## The start of a session

A before hook on [`authn.session.start`](14-action-hooks.md#authnsessionstart) chooses the role a new session starts with: it sets `ctx.input.ceiling`, which the session stores as its `ActiveRole`. `@spinajs/users` registers `OrderedActiveRoleHook` there ([Role switch and access response](../users/14-role-switch-and-access-response.md)).

## Who may administer credentials

A `CredentialAdminRule`, the first before hook on `authn.admin.credentials`, decides who may administer whose credentials. `@spinajs/users` registers `AuthzCredentialAdminRule`. See [Action hooks](14-action-hooks.md#authnadmincredentials-and-credentialadminrule).

## `CredentialExtractor`

`extract(request)` turns a `SignedRequest` (method, target URI, lower-case headers, optional body) into `Credentials`, or `null` when it reads nothing. `AuthnMiddleware` asks every registered extractor in ascending `order` and takes the first non-null answer. Extraction is synchronous and reads headers only: verification belongs to the strategy, after the throttle.

The default order: HTTP signature headers give `http-signature`; `Authorization: Bearer` with a JWS of the assertion `typ` gives `jws-assertion`; other bearer values give `bearer`; `x-api-key` gives `bearer`. Add an extractor for a new header format, and a strategy for its kind. See [`@spinajs/authn-http`](../authn-http/README.md).

## Related

- [Action hooks](14-action-hooks.md): the authn actions an `ActionHook` can run around.
- [Contracts and packages](02-contracts-and-packages.md): every contract and its implementation.
- [`@spinajs/users`](../users/README.md): the shipped guards, the credential admin rule, the role source and the response extension.
- [`@spinajs/authn-http`](../authn-http/README.md): where the HTTP hooks are called.
