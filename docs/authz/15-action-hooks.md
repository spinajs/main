# Action hooks

`@spinajs/authz` declares three actions for [`@spinajs/hooks`](../hooks/README.md). An `ActionHook` registered for them runs code around an admin command, a whole admin batch, or (opt-in) an access check. Use it to freeze admin writes during a maintenance window, to veto a role in a tenant, or to notify another system after a check.

How to write a hook, and what `before`, `after` and `failed` mean, is in [Writing a hook](../hooks/01-writing-a-hook.md). This page covers only what is specific to authz.

## The actions

| Action | Runs | Input | Mutable | `after` sees |
| --- | --- | --- | --- | --- |
| `authz.admin.batch` | In `AuthzAdmin.execute` (and every sugar method), before the first command is validated. Not for an empty batch. | `actor`, `commands`, `opts?` | `commands` | `{ results, replayed, dryRun }` of the batch: failed results too, and the results of a dry run or a replay |
| `authz.admin.command` | Per command, after `validate()` and the permission check, before `AdminGuard.check()`. The built-in `ListSupportHook` always matches it. | `actor`, `command` | `command` | the `command` that passed validation and the hook phase (not yet guarded or committed) |
| `authz.check` | In `check`, `can` and `assert`, after the engine's decision, only when `authz.hooks.check` is `true`. | `principal`, `permission`, `resource` | none | the `Decision` |

All three are refusable. Hooks are application-wide: `Hooks` is resolved from the domain container, which falls back to the root, so register hooks in the root container.

## Admin commands

The order inside `AuthzAdmin.execute` is:

1. The `authz.admin.batch` hook.
2. For each command, in phase A (outside the transaction): the handler's `validate()`, the actor's permission check, then the `authz.admin.command` hooks, `ListSupportHook` last.
3. A `command` a hook changed is copied, frozen and put through the same `validate()` and permission check again. A `Date` edited in place counts as a change. A command no hook changed is not checked twice.
4. In phase B (the transaction), `AdminGuard.check()` and `apply()` for the command the hook left.

Product rules on commands (refuse external invites, require an expiry) are before hooks here; they replace `AuthzCommandValidator`, removed in 3.x. Note that they run after the permission check, where the validators ran before it, and that a refusal answers `hook:<code>`.

### The list-support check

`ListSupportHook` is registered by `@spinajs/authz` at import. It runs every `ListSupportGuard` of the domain's container lineage on a `policy.put` or `rule.put` (`AbacListSupportGuard`, `RbacRuleListGuard`), with order `Number.MAX_SAFE_INTEGER`, so it judges the command the other hooks leave. AuthzAdmin checks a command again itself when a hook replaced it after `ListSupportHook` judged it. Its refusals keep their answers: `not_list_filterable` with the field `policy` or `rule`, a guard's own `AuthzAdminFailure` code, or an `AuthzConfigError` that rejects the batch. They never become `hook:<code>`.

Because this hook always matches `authz.admin.command`, every admin command runs through the hooks runner; `authz.admin.batch` still costs nothing without a hook of its own.

A hook can only narrow a command, never widen it. A hook that raises the role of a grant gets `forbidden` or `escalation`, because the permission check and the guard decide on the changed command. A command a hook returns is deep-copied and frozen, so a hook must assign a new object (`ctx.input.command = { ...ctx.input.command, expiresAt }`) instead of editing the one it got. A value that is not plain data fails with `invalid_batch`.

```ts
import { ActionHook } from '@spinajs/hooks';
import type { BeforeContext } from '@spinajs/hooks';

// Every grant expires after a year unless it says otherwise.
export class DefaultExpiry extends ActionHook<'authz.admin.command'> {
  readonly actions = ['authz.admin.command'] as const;

  before(ctx: BeforeContext<'authz.admin.command'>): void {
    const { command } = ctx.input;
    if (command.kind === 'assignment.grant' && !command.expiresAt) {
      ctx.input.command = { ...command, expiresAt: new Date(Date.now() + 365 * 24 * 3600_000) };
    }
  }
}
```

### What `after` means

- **`authz.admin.command` `after`** runs in phase A, when the command has passed `validate()`, the permission check and the hook phase. It does **not** mean the command was committed: the guard and `apply()` come later, so the command can still be refused by the guard, roll back with the rest of the batch, or be a dry run.
- **Committed-effect logic** (notify another system, invalidate a copy) belongs in `authz.admin.batch` `after`. It runs once the whole batch is done and gets `{ results, replayed, dryRun }`. It also runs when a command failed (`ok: false`), for a dry run (`dryRun: true`) and for a replay (`replayed: true`, the stored results of a batch committed earlier). Only a batch with all results `ok`, `dryRun: false` and `replayed: false` was committed just now.

### Answers

| What happened | `execute` | The sugar methods |
| --- | --- | --- |
| An `authz.admin.command` hook refused with `ctx.refuse('frozen')` | The batch fails at that command: `ok: false` with `error.code` `hook:frozen`, and nothing is written. | Throw `AuthzAdminFailure` with code `hook:frozen`. |
| An `authz.admin.batch` hook refused | Throws `AuthzAdminFailure` with code `hook:<code>` before any command runs. | The same. |
| A hook threw, timed out or passed `hooks.maxDepth` | `error.code` `hook_error` at that command (for the batch hook: thrown). | The same. |

[`@spinajs/authz-http-admin`](../authz-http-admin/README.md) returns the same result list, so a refused command shows `hook:<code>` in the response body.

A batch with an `idempotencyKey` that the backend already committed returns its stored results after the batch hook ran; the command hooks do not run for a replay.

## The opt-in check hook

`authz.check` is off by default, because a check is the hottest path of the library. Turn it on in the root `authz` config:

```ts
export default {
  authz: { hooks: { check: true } },
};
```

With the switch off, `check`, `can` and `assert` never touch `Hooks`. With it on:

- The hook runs after the decision cache lookup, on the decision the engine returns. `resource` is the normalised `ResourceRef` of that decision.
- A refusal returns a deny `Decision` with `reason.code` `hook:<code>` (`hook_error` when the hook threw). It is built after the caches, so it is never stored in L1 or L2: the next check without the refusing hook is served from the cache as before.
- A hook never turns a deny into an allow. A deny the engine made stays as it is, with its own reason, whatever the hooks do.
- `after` hooks see the `Decision`. `explain`, `inspect`, `checkMany`, `checkAll` and `filter` are not hooked.
- The permission check of `AuthzAdmin` goes through `AuthzService.check`, so with the switch on a refusal also makes admin calls fail with `forbidden`: the actor's permission check is hooked like any other check. A hook that refuses broadly can therefore lock admins out; limit it to the principals or permissions it means to stop.
- A forced deny is audited as a `deny` entry with reason `hook:<code>` when `authz.audit.denials` is on, and keeps the `trace` of an explain request.

## Related

- [Writing a hook](../hooks/01-writing-a-hook.md) and [Declaring actions](../hooks/02-declaring-actions.md).
- [AuthzAdmin](10-authz-admin.md): the command bus the first two actions wrap.
- [Host, boot and configuration](04-host-boot-and-configuration.md): `authz.hooks.check`.
