# Role switch and access response

Two authn hooks that users fills from authz. `RbacRoleSource` lists the roles a user holds, for role switch, MFA `forceForRoles` and authn-token's owner check. `AccessResponseExtension` adds `Access` (the principal's `AccessSummary`) to the login, MFA, role switch, impersonation and whoami answers.

## How it works

### `RbacRoleSource.rolesOf(principal)`

1. Answers `[]` for a principal that is not a `user`, acts `onBehalfOf` someone (an agent or delegate), or carries authn facts of a non-interactive sign-in (a method other than `password`, `oidc`, `ldap`, `saml`). A principal without authn facts (authn-token's owner check) gets all its roles.
2. Resolves the access domain (`authz.http.access.domain`); its container must register its own `RbacService`, or it throws `AuthzConfigError`.
3. Reads the live role assignments of the principal at any scope, without its sign-in and ceiling (a role switch would otherwise hide the roles to switch back to), de-duplicates and sorts them.
4. Flags each `{ role, requirePassword }`: with `authz.principals.roleSwitch.requirePassword` unset or `null`, every role requires the password; with a list, only the listed roles. A value that is not a list of strings throws `AuthzConfigError`.

An impersonation session gets the target's roles, which are the session's.

### `AccessResponseExtension.extend(kind, principal, body)`

1. authn-http resolves every `AuthnResponseExtension` (`Array.ofType`) while building a `login`, `mfa`, `role-switch`, `impersonation` or `whoami` answer.
2. `AccessResponseExtension` sets `body.Access` to `AuthzService.summary(principal)` of the access domain, what `GET /user/access` answers.
3. A failing summary rejects: an answer without `Access` would hide the failure.

`buildUserWithAccess(user, principal)` builds the dehydrated user plus its `Access`, typed `UserWithAccess`: `user.dehydrateWithRelations({ dateTimeFormat: 'iso' })`, then `AccessResponseExtension` as for a `whoami` answer. It throws `InvalidArgument` when `principal` is not `user:<user.Uuid>`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.http.access.domain` | `string` | `'root'` | an authz domain | Domain the roles and the summary come from. |
| `authz.principals.roleSwitch.requirePassword` | `string[] \| null` | unset: every role | role names | Roles a role switch activates only after a fresh password (`ROLE_SWITCH_PASSWORD_KEY`). |
| `authz.principals.roleSwitch.initial` | `{ order: string[] } \| null` | unset: every held role | `order`: unique role names, at least one | The role a new session starts on (`INITIAL_ROLE_KEY`): the first role of `order` the user holds. No listed role held: every held role, as unset. |

### Initial active role

`OrderedActiveRoleHook` is the before hook on [`authn.session.start`](../authn/14-action-hooks.md#authnsessionstart) users registers. With `authz.principals.roleSwitch.initial` set, a login (the OIDC callback included) or an MFA completion asks `RbacRoleSource` for the user's roles and starts the session as if it had switched to the first role of `order` the user holds: `ActiveRole` is that role, and the login answer's `Access` shows only its grants. 2.x activated the user's first role at login; set `order` to your roles in that priority to keep it. The user can still switch to any held role with `POST /auth/active-role`.

The hook leaves the session start as it is when the key is unset or `null`, the user holds no listed role, no `RoleSource` is registered, or an earlier hook on the action already set a ceiling. To pick the start role in your own hook and keep this one as the fallback, give yours a lower `order`.

```ts
// config/authz.ts in your app
export default {
  authz: {
    principals: {
      roleSwitch: {
        requirePassword: ['admin', 'admin.users'],
        // Start every session on the user's first role in this order.
        initial: { order: ['user', 'admin'] },
      },
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Role source | `RoleSource` (`@spinajs/authn/contracts`), singleton, by type; optional | `RbacRoleSource` | your source; none: role switch answers 404, MFA `forceForRoles` sees no roles | Subclass and filter `rolesOf()`; `DI.register(Sub).as(RoleSource)` after importing users. |
| Initial active role | `ActionHook` on `authn.session.start`, registered on import | `OrderedActiveRoleHook` | your own before hook | Set `ctx.input.ceiling` in a hook with a lower `order`; `OrderedActiveRoleHook` then keeps it. |
| Response fields | `AuthnResponseExtension` list (`Array.ofType`) | `AccessResponseExtension` | more extensions | `@Injectable(AuthnResponseExtension)` on your class adds fields; `DI.unregister(AccessResponseExtension)` removes `Access`. |

### Custom role source: keep technical roles out of the switcher

Roles named `system.*` are held by service accounts and must never be offered in the UI. Filtering them also hides them from MFA `forceForRoles` and the token owner check, so do it only for roles those do not need.

```ts sample
import { DI } from '@spinajs/di';
import { RoleSource } from '@spinajs/authn/contracts';
import type { Principal } from '@spinajs/authn/contracts';
import { RbacRoleSource } from '@spinajs/users';

export class HumanRoleSource extends RbacRoleSource {
  public async rolesOf(principal: Principal) {
    return (await super.rolesOf(principal)).filter((offer) => !offer.role.startsWith('system.'));
  }
}

DI.register(HumanRoleSource).as(RoleSource);
```

### Custom response extension: feature flags in the login answer

```ts sample
import { Injectable } from '@spinajs/di';
import { AuthnResponseExtension } from '@spinajs/authn/contracts';
import type { Principal } from '@spinajs/authn/contracts';

@Injectable(AuthnResponseExtension)
export class FeatureFlagsExtension extends AuthnResponseExtension {
  public async extend(kind: 'login' | 'mfa' | 'role-switch' | 'impersonation' | 'whoami', principal: Principal, body: Record<string, unknown>): Promise<void> {
    if (kind === 'login' || kind === 'whoami') {
      body.Features = { newBilling: principal.attributes?.plan === 'enterprise' };
    }
  }
}
```

## Important behaviour

- `rolesOf()` lists roles held at **any** scope. Offering a scoped role to a role switch is harmless: the ceiling only narrows.
- With `requirePassword` unset, every switch asks for the password (fail safe).
- `Access` reflects the principal as authn will carry it, ceiling included; a role switch changes it.
- The summary runs on every login and whoami; a slow ABAC model slows those answers.

## Best practices

- List only high-risk roles in `requirePassword` once your users switch roles often; the default asks for every role.
- Read roles and permissions in clients from `Access`; the user payload carries no role field.
- Use `buildUserWithAccess()` in your own endpoints that answer with the user record and its access.

## Patterns and antipatterns

```ts
// Don't: a bare string spreads into characters and is refused at runtime
config.set('authz.principals.roleSwitch.requirePassword', 'admin');

// Do
config.set('authz.principals.roleSwitch.requirePassword', ['admin']);
```

## Examples

### A "me" endpoint with the user record and its access

```ts sample
import { buildUserWithAccess, getUser } from '@spinajs/users';
import type { UserWithAccess } from '@spinajs/users';
import type { Principal } from '@spinajs/authn/contracts';

export async function me(principal: Principal): Promise<UserWithAccess> {
  const user = await getUser(principal.id);
  return buildUserWithAccess(user, principal);
}
```

## Related

- [Impersonation and credential admin guards](13-impersonation-and-credential-admin-guards.md): the other hooks reading the access domain.
- [`@spinajs/authn`](../authn/README.md): role switch, MFA policy and response building.
- [`@spinajs/authz`](../authz/README.md): `AccessSummary` and domains.
