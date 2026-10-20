# Token roles

A principal that authenticated with a token (an API key, a personal access token) uses only some of its owner's roles. `authz.token.excludedRoles` removes roles from every token, and a `TokenRolePolicy` narrows the rest. Both only narrow: a token is never above its owner (B07, B24).

## How it works

1. `RbacModel` always adds `tokenRoleExtension` as its last extension, also when the app passes its own `extensions`.
2. At `init` the extension reads `authz.token.*` from the domain's `Configuration` and resolves the `TokenRolePolicy` class whose name `authz.token.rolePolicy.service` gives (`loadTokenRoleRules`). An unknown name throws `AuthzConfigError`.
3. On every check, its `gather` runs last. It acts when the principal or the actor authenticated with a token (`principal.authn.method === 'token'`; an unreadable `authn` counts as a token).
4. The candidate roles are the token's `ceiling.roles`, or every defined role when the token has none. Roles matching `excludedRoles` go.
5. `TokenRolePolicy.allowedRoles(owner, roles, profile)` picks from the rest; `profile` is the principal's `attributes.profile`. The answer is cut to the candidates, so a policy cannot widen.
6. Only assignments of the allowed roles stay, and the principal's `ceiling.roles` becomes the allowed list, so implied roles and set memberships follow the same rule.

With no excluded roles and the default policy, the extension does nothing.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.token.excludedRoles` | `string[]` | `[]` | a role name, or `prefix.*` | Roles no token uses. `route.*` covers `route.home` and `route.admin.users`, not `routes.read` or `route`. A role that extends an excluded role keeps the grants it inherits. |
| `authz.token.rolePolicy.service` | `string` | `'OwnRolesTokenRolePolicy'` | a registered `TokenRolePolicy` class name | The policy that picks the token's roles. |

```ts
authz: {
  token: {
    excludedRoles: ['admin', 'billing.*'],
    rolePolicy: { service: 'OwnRolesTokenRolePolicy' },
  },
}
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `TokenRolePolicy` | `TokenRolePolicy`, resolved by class name at model `init` (per child container when the class is `@PerChildInstance`) | `OwnRolesTokenRolePolicy`: every role the owner holds | your own | `@Injectable(TokenRolePolicy)` on a subclass, then set `authz.token.rolePolicy.service` to its class name. |

`TokenRolePolicy` has two methods:

- `allowedRoles(owner, roles, profile?)`: **synchronous**, no IO. RBAC asks it on every check of a token principal. `roles` may hold roles the owner lacks; filter them, never infer ownership.
- `allowedProfiles(owner)`: the profiles a token of `owner` may be pinned to; default none. users-http offers them at `GET /user/tokens/profiles` ([Own account](../users-http/03-own-account.md)).

### `TokenRolePolicy`: report-only tokens

```ts sample
import type { Principal } from '@spinajs/authz';
import { TokenRolePolicy } from '@spinajs/authz-rbac';
import { Injectable } from '@spinajs/di';

const REPORT_ROLES = new Set(['report.viewer', 'analyst']);

@Injectable(TokenRolePolicy)
export class ReportTokenRolePolicy extends TokenRolePolicy {
  allowedRoles(_owner: Principal, roles: readonly string[], profile?: string): readonly string[] {
    return profile === 'reports' ? roles.filter((r) => REPORT_ROLES.has(r)) : roles;
  }

  allowedProfiles(): readonly string[] {
    return ['reports'];
  }
}

// config: authz.token.rolePolicy.service: 'ReportTokenRolePolicy'
```

## Important behaviour

- **Never wider.** The policy's answer is intersected with the candidate roles; a role the owner holds no assignment of grants nothing.
- **Failures deny.** A policy that throws, or answers anything but an array, makes the RBAC vote a `model_error` deny.
- **Names, not closures.** `excludedRoles` and `ceiling.roles` match the assigned role's name. Excluding `admin` does not exclude `superadmin`, which extends it.
- **Delegation.** Under inherit delegation the models run as the delegate and the agent is the actor; a token actor narrows the delegate's roles too.

## Best practices

- Exclude administrative roles from every token with `excludedRoles`, and use a policy for product rules such as profiles.
- Keep `allowedRoles` a pure function of its arguments and config: it runs on every check.

## Related

- [How a check resolves](05-check-resolution.md): the extension is the last gather.
- [Model extensions](12-model-extensions.md): the `RbacExtension` hooks it uses.
- [Role switch and access response](../users/14-role-switch-and-access-response.md): the other `ceiling.roles` source.
