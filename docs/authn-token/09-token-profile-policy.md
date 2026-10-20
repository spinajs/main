# Token profile policy

`TokenProfilePolicy` lists the profiles an owner may pin a token to. A profile is one role name, stored in the token's `Profile` column; a pinned token carries it as `attributes.profile`. The default, `NoTokenProfilesPolicy`, allows none, so a token with a profile is refused until you register a policy.

## How it works

1. `DbTokenService.create` with `profile` calls `allowedProfiles(owner)`. A profile not in the answer refuses the token with `invalid_scope`. Agent tokens never take a profile.
2. The profile is stored in `Profile`.
3. `DbTokenService.validate` calls `allowedProfiles(owner)` again for a pinned token on **every** use. A profile no longer in the answer fails the token with `invalid_credentials`.
4. On success the profile reaches the principal as `attributes.profile` (through `StrategyOutcome.attributes` and the `PrincipalFactory`).
5. At check time authz-rbac passes it to its `TokenRolePolicy.allowedRoles(owner, roles, profile)`, which decides how the profile narrows the token's roles; see [`@spinajs/authz-rbac`](../authz-rbac/README.md).
6. `GET /user/tokens/profiles` of `@spinajs/users-http` answers the same list, looked up by the name `'TokenProfilePolicy'`; see [Own account routes](../users-http/03-own-account.md).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Profile policy | `TokenProfilePolicy`; singleton; `@Injectable(TokenProfilePolicy)` when the package loads; injected into `DbTokenService`'s `Profiles` property | `NoTokenProfilesPolicy` (answers `[]`) | none | Subclass `TokenProfilePolicy`, implement `allowedProfiles(owner)`, and register it with `@Injectable(TokenProfilePolicy)` before `TokenService` is first resolved. |

### Profile policy: custom implementation

Let users pin a token to a read-only reporting role, and let members of the finance team also pin one to `finance-export`. The policy is asked on every token request, so keep it fast.

```ts sample
import { TokenProfilePolicy } from '@spinajs/authn-token';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { Injectable } from '@spinajs/di';

const FINANCE_TEAM = new Set(['8d2f4c1a-6b3e-4f7a-9c1d-5e2b7a9f3c40']);

/** Every user may pin `reports`; finance users may also pin `finance-export`. */
@Injectable(TokenProfilePolicy)
export class ReportingTokenProfilePolicy extends TokenProfilePolicy {
  public async allowedProfiles(owner: IdentityRef): Promise<readonly string[]> {
    if (owner.type !== 'user') {
      return [];
    }
    return FINANCE_TEAM.has(owner.id) ? ['reports', 'finance-export'] : ['reports'];
  }
}
```

## Important behaviour

- **Asked at create and on every use.** Removing a profile from the answer ends every token pinned to it on its next request.
- **A profile never widens.** It names a role the token is pinned to; authz-rbac still keeps only roles the owner holds.
- **Must be registered.** `DbTokenService` injects the policy with the strict check (`{ check: true }`); so resolving it fails when no `TokenProfilePolicy` is registered. Importing the package registers `NoTokenProfilesPolicy`.
- **Not authz-rbac's `TokenRolePolicy.allowedProfiles`.** That method is a separate hook of authz-rbac; the create and validate paths here read only this policy.

## Related

- [Token roles, scopes and agent tokens](03-token-scopes.md): how the profile sits next to roles and scope.
- [API token authentication](02-token-authentication.md): where the profile is re-checked.
- [`@spinajs/users-http` own account routes](../users-http/03-own-account.md): the route that offers profiles to a client.
