# Integration hooks

Small contracts through which an app, `@spinajs/users` or `@spinajs/authn-http` plug into the authentication flow without authn importing them. Each is an abstract class you register with `@Injectable(<Hook>)`.

To run code around a login, an MFA completion, a step-up, an impersonation or an account link (to refuse it, change its attributes or observe its result) register an `ActionHook` instead: see [Action hooks](14-action-hooks.md) and [`@spinajs/hooks`](../hooks/README.md). `authn.login.identified` replaces the `ExternalLoginHook` of 3.0.

| Hook | Called by | Resolved as | Shipped implementation |
| --- | --- | --- | --- |
| `AuthnResponseExtension` | `@spinajs/authn-http`, when it builds an answer | Every registration | `AccessResponseExtension` (users) |
| `RoleSource` | `DefaultMfaPolicy` (`forceForRoles`), `@spinajs/authn-http` (role switch) | One, optional | `RbacRoleSource` (users) |
| `SessionStartHook` | `@spinajs/authn-http`, once a login or an MFA completion has issued the active session | Every registration, in registration order; the first ceiling wins | `OrderedActiveRoleHook` (users) |
| `CredentialExtractor` | `@spinajs/authn-http`'s `AuthnMiddleware` | Every registration, by `order` | The extractors of `@spinajs/authn-http` |
| `ImpersonationGuard` | `AuthnImpersonationService` | One, optional | `AuthzImpersonationGuard` (users); see [Impersonation](11-impersonation-and-active-role.md) |

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

## `SessionStartHook`

`onStart(kind, session, principal, sessions)` runs once per new active session: `kind` is `login` (password, key, email code and passkey login) or `mfa` (the MFA completion of a pending login); a pending login, a step-up (`POST /auth/mfa/step-up`) and a re-authentication (`POST /auth/reauth`) ask no hook, so they keep the session's `ActiveRole`. It returns a `Ceiling` or `undefined`:

1. The hooks are asked in registration order; the first one that answers a ceiling decides, and later ones are not asked.
2. The ceiling must name at most one role and nothing else: `{ roles: [role] }`, or `{ roles: [] }` for none. It is stored as the session's `ActiveRole`, the key a role switch writes, so `GET /auth/active-role` shows it, every later request carries it as `ceiling.roles`, and the user switches away from it as from any role switch.
3. The answer of the login or MFA route is built for the narrowed principal, so its `Access` shows only that role.
4. A hook that throws, or a ceiling with more than one role or any other field, ends the session and fails the request with 500: the session never lives on with every held role.

`@spinajs/users` registers `OrderedActiveRoleHook`, which `authz.principals.roleSwitch.initial` drives ([Role switch and access response](../users/14-role-switch-and-access-response.md)). With the key unset it answers nothing, so a 3.0.1 app keeps every held role.

## Who may administer credentials

`CredentialAdminGuard` is gone (D17). The rule is now a `CredentialAdminRule`, an `ActionHook` on `authn.admin.credentials`: see [Action hooks](14-action-hooks.md#authnadmincredentials-and-credentialadminrule).

## `CredentialExtractor`

`extract(request)` turns a `SignedRequest` (method, target URI, lower-case headers, optional body) into `Credentials`, or `null` when it reads nothing. `AuthnMiddleware` asks every registered extractor in ascending `order` and takes the first non-null answer. Extraction is synchronous and reads headers only: verification belongs to the strategy, after the throttle.

The default order: HTTP signature headers give `http-signature`; `Authorization: Bearer` with a JWS of the assertion `typ` gives `jws-assertion`; other bearer values give `bearer`; `x-api-key` gives `bearer`. Add an extractor for a new header format, and a strategy for its kind. See [`@spinajs/authn-http`](../authn-http/README.md).

## Related

- [Action hooks](14-action-hooks.md): the authn actions an `ActionHook` can run around.
- [Contracts and packages](02-contracts-and-packages.md): every contract and its implementation.
- [`@spinajs/users`](../users/README.md): the shipped guards, the credential admin rule, the role source and the response extension.
- [`@spinajs/authn-http`](../authn-http/README.md): where the HTTP hooks are called.
