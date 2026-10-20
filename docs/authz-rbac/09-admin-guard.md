# Admin guard

`DefaultAdminGuard` is the `AdminGuard` that `AuthzAdmin` runs inside every batch transaction, before each command applies. It refuses role changes that would let an actor raise itself, lock itself or everyone out of administration, or touch system roles.

`SYSTEM` skips the guard (the core audits it). Every other actor, an admin UI user included, is checked.

## How it works

1. `AuthzAdmin` resolves the guard `authz.admin.guard.service` names (default `DefaultAdminGuard`) and calls `check(actor, command, ctx)` for each command, after the permission check and inside the transaction. The guard sees the batch's own earlier writes.
2. The guard skips `rule.delete`, `policy.*`, `scope.*`: their permission is their guard.
3. It reads `authz.admin.guard` from the `Configuration` of the admin call's container on every call, and the role definitions of the domain's `RoleStore`s once per batch.
4. **Escalation** (`preventEscalation`). For every role a command gives (a grant, a set membership and the roles that set holds, a link, a later expiry, an added tag), `RbacAdminFacts.covers(actor, role, scope)` must hold: the actor holds every permission the role's closure grants there, unconditionally, with at least the same fields. Every ladder role the grant gives, through `extends`, lower ranks and `implies`, must rank at or below the actor's own effective role on that ladder. A rule's `minRole` or `maxRole` follows the same rank check. A deny role is never an escalation.
5. **Removal ranks** (`preventEscalation`). A row the command revokes, re-expires or edits may not hold a ladder role ranking above the actor's own at the row's scope.
6. **System roles** (`protectSystemRole`). A command that touches a row of a role with `assignable: false` is refused (`protected_role`); only `SYSTEM` changes those rows.
7. **Keep holders** (`keepHolders`). For each `{ role, scopeType }`, every scope of that type the command takes a holder from must keep a live holder: an account, or a set with a live account member.
8. **Self-lockout** (`preventSelfLockout`). The actor may not remove a row on its own path to `privilegedPermission`: an own row of a role that grants it, an own row that makes it a member of a set holding one, or such a row of its set. A deny of `privilegedPermission` that reaches the actor counts as a removal.
9. **Last holder** (`preventLastPrivilegedRemoval`). Removing a `$global` path to `privilegedPermission` is refused when no other principal keeps one that the model surely honours (no tag, relation, `on` or share link, lasting at least as long) and whose account `AccountStatusSource` reports in service.

The rows a command removes come from `plannedRemovals(command, ctx)`, the same function the write handlers use, so the guard and the handlers never disagree.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.admin.guard.service` | `string` | `'DefaultAdminGuard'` | a registered `AdminGuard` class name | The guard `AuthzAdmin` runs. A missing guard fails every call with `AuthzConfigError`. |
| `authz.admin.guard.privilegedPermission` | `string` | `'users:update'` | a permission name | The permission self-lockout and last holder protect. Required while either is on. |
| `authz.admin.guard.protectSystemRole` | `boolean` | `true` | | Refuse changes to rows of `assignable: false` roles. |
| `authz.admin.guard.preventEscalation` | `boolean` | `true` | | Refuse grants above the actor's own access or rank. |
| `authz.admin.guard.preventSelfLockout` | `boolean` | `true` | | Refuse removing the actor's own path to `privilegedPermission`. |
| `authz.admin.guard.preventLastPrivilegedRemoval` | `boolean` | `true` | | Refuse removing the last `$global` holder of `privilegedPermission`. |
| `authz.admin.guard.keepHolders` | `{ role, scopeType }[]` | `[]` | role names and types | Every scope of `scopeType` keeps a live holder of `role`. |

```ts
authz: {
  admin: {
    guard: {
      privilegedPermission: 'users:update',
      keepHolders: [{ role: 'team.owner', scopeType: 'team' }],
    },
  },
}
```

The package config sets the first six defaults; `@spinajs/teams` adds the `team.owner` keep-holder rule.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Admin guard | `AdminGuard`, singleton, `@Injectable(AdminGuard)` at import; chosen by `authz.admin.guard.service` | `DefaultAdminGuard` | your own `AdminGuard` | Subclass and register `@Injectable(AdminGuard)`, then name the class in `authz.admin.guard.service`. |
| Actor facts | `RbacAdminFacts`, singleton, at import | `CheckRbacAdminFacts`: checks through `ctx.authz` with `fresh: true` | your own | `@Injectable(RbacAdminFacts)` on a subclass. |
| Account status | `AccountStatusSource`, optional | none in this package; `@spinajs/users` ships `UserAccountStatusSource` | your own | `@Injectable(AccountStatusSource)`. Without one, a warning is logged once and every holder counts as in service. |

### `AccountStatusSource`: count only active accounts as remaining admins

`inService(refs)` answers, per `principalKey`, whether the account can still act. A ref it leaves out, or a call that throws, counts as out of service.

```ts sample
import { principalKey } from '@spinajs/authz';
import type { PrincipalRef } from '@spinajs/authz';
import { AccountStatusSource } from '@spinajs/authz-rbac';
import { Injectable } from '@spinajs/di';

const DISABLED = new Set(['user:ops-bot']);

@Injectable(AccountStatusSource)
export class OpsAccountStatus extends AccountStatusSource {
  async inService(refs: readonly PrincipalRef[]): Promise<ReadonlyMap<string, boolean>> {
    return new Map(refs.map((r) => [principalKey(r), r.type === 'user' && !DISABLED.has(principalKey(r))]));
  }
}
```

[users-http's account guard](../users-http/08-account-guard.md) reads the same port for deactivate, ban and delete.

### `AdminGuard`: a stricter guard on top of the default

Extend `DefaultAdminGuard` to add a product rule and keep the default checks.

```ts sample
import { AdminGuard, AuthzAdminFailure } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, Principal } from '@spinajs/authz';
import { DefaultAdminGuard } from '@spinajs/authz-rbac';
import { Injectable, Singleton } from '@spinajs/di';

@Singleton()
@Injectable(AdminGuard)
export class NoGlobalGrantsGuard extends DefaultAdminGuard {
  async check(actor: Principal, c: AuthzCommand, ctx: AdminContext): Promise<void> {
    if (c.kind === 'assignment.grant' && c.scope.type === '$global') {
      throw new AuthzAdminFailure('forbidden', 'roles are granted per org, never at $global', 'scope');
    }
    await super.check(actor, c, ctx);
  }
}

// config: authz.admin.guard.service: 'NoGlobalGrantsGuard'
```

## Important behaviour

- **Fail closed.** Unknown roles in a grant's closure, a glob that matches nothing, a missing permission registry or an implied role that bypasses rules count as not covered.
- **Checks are fresh.** `CheckRbacAdminFacts` checks the actor with `fresh: true`, so a role revoked from the actor moments ago never lets it grant.
- **Conservative paths.** An actor with two paths to `privilegedPermission` is still refused removing one of them: the guard does not judge tags, relations or caps.
- **Transfers.** Grant the new holder before revoking the old one in one batch; the guard checks each command after the earlier ones.
- **Error codes.** `escalation`, `self_lockout`, `last_holder`, `protected_role`; authz-http-admin answers them with `403`.

## Best practices

- Set `privilegedPermission` to the permission your admins really need to repair access (`users:update` by default).
- Register an `AccountStatusSource` (install `@spinajs/users`), or a deactivated admin still counts as the remaining holder.
- Never call `AuthzAdmin` as `SYSTEM` on behalf of a user; pass the user, so the guard runs.

## Related

- [Assigning roles](04-assigning-roles.md): the commands the guard judges.
- [Ladders, tags and implied roles](06-ladders-tags-and-implied-roles.md): ranks the guard compares.
- [AuthzAdmin](../authz/10-authz-admin.md): where the guard runs in the command pipeline.
- [`@spinajs/users-http` account guard](../users-http/08-account-guard.md): the same rules for account deactivation.
