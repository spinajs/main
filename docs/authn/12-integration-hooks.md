# Integration hooks

Small contracts through which an app, `@spinajs/users` or `@spinajs/authn-http` plug into the authentication flow without authn importing them. Each is an abstract class you register with `@Injectable(<Hook>)`.

| Hook | Called by | Resolved as | Shipped implementation |
| --- | --- | --- | --- |
| `ExternalLoginHook` | `DefaultAuthnService`, after an external login | Every registration of the lineage | None |
| `AuthnResponseExtension` | `@spinajs/authn-http`, when it builds an answer | Every registration | `AccessResponseExtension` (users) |
| `RoleSource` | `DefaultMfaPolicy` (`forceForRoles`), `@spinajs/authn-http` (role switch) | One, optional | `RbacRoleSource` (users) |
| `SessionStartHook` | `@spinajs/authn-http`, once a login or an MFA completion has issued the active session | Every registration, in registration order; the first ceiling wins | `OrderedActiveRoleHook` (users) |
| `CredentialAdminGuard` | `@spinajs/authn-http`, the credential admin routes | One, optional | `AuthzCredentialAdminGuard` (users) |
| `CredentialExtractor` | `@spinajs/authn-http`'s `AuthnMiddleware` | Every registration, by `order` | The extractors of `@spinajs/authn-http` |
| `ImpersonationGuard` | `AuthnImpersonationService` | One, optional | `AuthzImpersonationGuard` (users); see [Impersonation](11-impersonation-and-active-role.md) |

## `ExternalLoginHook`

`afterLogin(identity, external)` runs after a successful external login (OIDC) of an interactive strategy, for example to sync the user's groups from the identity provider.

1. `DefaultAuthnService` resolves the identity of the external subject and checks its status.
2. It resolves every `ExternalLoginHook` of the container lineage, per login, so a hook registered late still runs.
3. It calls each hook in turn, before the MFA policy and before the session.
4. A hook that throws, or cannot be built, fails the login with the opaque answer and no session. The audit reason is `hook_error`, with the error class.

Earlier hooks are not rolled back when a later one throws. Write hooks that are safe to run twice. No hook runs for an identity outcome, a per-request strategy, a refused status or an unlinked subject.

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { ExternalLoginHook } from '@spinajs/authn';
import type { ExternalSubject, IdentityRef } from '@spinajs/authn';

export abstract class TeamDirectory {
  abstract syncGroups(user: IdentityRef, groups: readonly string[]): Promise<void>;
}

@Injectable(ExternalLoginHook)
export class SyncIdentityProviderGroups extends ExternalLoginHook {
  @Autoinject(TeamDirectory)
  protected Teams: TeamDirectory;

  async afterLogin(identity: IdentityRef, external: ExternalSubject): Promise<void> {
    const groups = external.claims?.groups;
    if (!Array.isArray(groups)) return;
    // Replaces the whole set, so a retried login gives the same result.
    await this.Teams.syncGroups(identity, groups.filter((g): g is string => typeof g === 'string'));
  }
}
```

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

`onStart(kind, session, principal, sessions)` runs once per new active session: `kind` is `login` (password and key login) or `mfa` (the MFA completion of a pending login); a pending login asks no hook. It returns a `Ceiling` or `undefined`:

1. The hooks are asked in registration order; the first one that answers a ceiling decides, and later ones are not asked.
2. The ceiling must name at most one role and nothing else: `{ roles: [role] }`, or `{ roles: [] }` for none. It is stored as the session's `ActiveRole`, the key a role switch writes, so `GET /auth/active-role` shows it, every later request carries it as `ceiling.roles`, and the user switches away from it as from any role switch.
3. The answer of the login or MFA route is built for the narrowed principal, so its `Access` shows only that role.
4. A hook that throws, or a ceiling with more than one role or any other field, ends the session and fails the request with 500: the session never lives on with every held role.

`@spinajs/users` registers `OrderedActiveRoleHook`, which `authz.principals.roleSwitch.initial` drives ([Role switch and access response](../users/14-role-switch-and-access-response.md)). With the key unset it answers nothing, so a 3.0.1 app keeps every held role.

## `CredentialAdminGuard`

`allowed(actor, target, action)` decides whether an admin may act on another identity's credentials. `action` is `password-reset`, `mfa-reset`, `sessions` or `tokens`. It answers `{ ok: true }` or `{ ok: false, code }` with `forbidden`, `protected_role`, `escalation` or `not_found`. The routes call it before any effect. Without a registration the credential admin routes answer 404. `@spinajs/users` registers `AuthzCredentialAdminGuard`.

## `CredentialExtractor`

`extract(request)` turns a `SignedRequest` (method, target URI, lower-case headers, optional body) into `Credentials`, or `null` when it reads nothing. `AuthnMiddleware` asks every registered extractor in ascending `order` and takes the first non-null answer. Extraction is synchronous and reads headers only: verification belongs to the strategy, after the throttle.

The default order: HTTP signature headers give `http-signature`; `Authorization: Bearer` with a JWS of the assertion `typ` gives `jws-assertion`; other bearer values give `bearer`; `x-api-key` gives `bearer`. Add an extractor for a new header format, and a strategy for its kind. See [`@spinajs/authn-http`](../authn-http/README.md).

## Related

- [Contracts and packages](02-contracts-and-packages.md): every contract and its implementation.
- [`@spinajs/users`](../users/README.md): the shipped guards, role source and response extension.
- [`@spinajs/authn-http`](../authn-http/README.md): where the HTTP hooks are called.
