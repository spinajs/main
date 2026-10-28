# CLI commands

Six `spinajs` CLI commands manage and inspect RBAC data: assign and revoke roles, explain a decision, check the config, and verify or rebuild the set membership table. Use them to create the first admin, to fix access by hand and to debug a deny.

## How it works

1. The package config adds `lib/cli/commands` of `@spinajs/authz-rbac` to `system.dirs.cli`, so the CLI finds the commands once the package is installed.
2. A command parses its arguments first. A bad command line prints one line and sets the exit code to 1, without booting authz.
3. A command that touches the RBAC DB stores (`authz:assign`, `authz:revoke`, `authz:explain`, the membership commands) resolves [`OrmMigrator`](../orm/10-migrations.md) first, which boots the ORM and runs the `Migration.OnStartup` pass as an app process does before serving. `authz:check-config` resolves it only when `authz.rbac.stores.roles` or `authz.rbac.stores.rules` names a store other than `ConfigRoleStore` / `ConfigRuleStore`, or the app registers its own `RoleStore`: with the config-backed stores it validates without a database. Then it resolves `AuthzService` (the boot validation runs), and runs its body as `SYSTEM` with the reason `cli` (`authz().runAs`). `AuthzAdmin` writes skip the admin guard as `SYSTEM` and are audited with the reason `cli`.
4. Any error becomes one line: an `AuthzAdminFailure` prints `<message> (<code>, <field>)`. The exit code is 1.

The app's RBAC wiring (`registerRbac`) must run in the CLI process too: the commands read the stores and `RbacService` it registers in the root container.

## Commands

| Command | Does |
| --- | --- |
| `authz:assign <subject> <role> [-s <scope>] [-e <iso>] [-t <tags>]` | `AuthzAdmin.assign`. `subject` and `scope` are `<type>:<id>` (split at the first `:`); the scope defaults to `$global`. `-e` is a future ISO 8601 date (UTC midnight) or a date-time with a zone. `-t` is a comma-separated list. Prints the assignment id. |
| `authz:revoke <subject> <role> [-s <scope>]` | `assignment.revokeWhere` for that subject, role and scope; prints the count. Fails when nothing matched. |
| `authz:revoke --id <id>` | `AuthzAdmin.revoke` of one assignment. `--id` cannot be combined with a subject, role or `--scope`. |
| `authz:explain <principal> <permission> [<resource>] [--json]` | `AuthzService.explain` for a principal built from `<type>:<id>`; prints the decision, reason, roles per ladder, fields and the trace, or the raw decision as JSON. |
| `authz:check-config [--explain-role <role>] [--unattended]` | Boots the authz service, loads the role stores and prints `OK: <n> role(s), <m> ladder(s)`. `--explain-role` lists the role's effective grants through `RbacService.grantsOf`. `--unattended` counts `authz_audit` rows with the reason `unattended` per resource type. |
| `authz:membership-verify` | Recomputes `authz_subject_membership` from the live assignments and prints `missing`, `extra` and `changed` rows; exit code 1 on any difference. |
| `authz:membership-rebuild [-d <domain>]` | Rewrites `authz_subject_membership` from the assignments in one `DbAuthzAdminBackend` transaction and bumps `authz_version` of the domain (default `root`). |

Subjects `system:*` and `unattended:*` are refused: those principals cannot hold roles.

## Requirements

| Command | Needs |
| --- | --- |
| `authz:assign`, `authz:revoke` | The RBAC write handlers (loaded by the command), a registered `AdminAssignmentStore` and an `AuthzAdmin` backend. |
| `authz:check-config --explain-role` | `RbacService` registered under the name `RbacService` in the root container (`registerRbac(DI.RootContainer, ...)`); otherwise "the RBAC model ... is not registered". |
| `authz:check-config --unattended` | The `authz_audit` table of `DbDecisionAudit` (authz-orm), read on the `authz` connection. |
| `authz:membership-*` | `AdminAssignmentStore` and `AdminMembershipStore`, from the root container or by the names `authz.rbac.stores.assignments` and `.membership` give; and `authz.rbac.maxSetDepth`. |

## Important behaviour

- **No guard.** The CLI acts as `SYSTEM`, so escalation, last-holder and self-lockout checks do not run. Validation (unknown role, `scopeTypes`, past expiry) still does.
- **Other processes' caches.** `authz:membership-rebuild` bumps the version, but running apps drop cached decisions only when their caches expire or they restart.
- **`authz:explain`** builds a bare principal (`authenticated: true`, no attributes, no ceiling), so conditions on principal attributes see none.

## Writing your own command

Extend `AuthzCliCommand` (exported by `@spinajs/authz-rbac`) to get the same boot: `authz()`, `admin()` and `asSystem()`.

| Member | Kind | Default | Override to |
| --- | --- | --- | --- |
| `touchesDb()` | protected method | `true` | Return `false` when the command reads no RBAC DB store: `authz()` then skips `OrmMigrator` and the command runs without a database. |
| `authz()` | protected method | resolves `OrmMigrator` when `touchesDb()` is `true`, then `AuthzService`, once | Not meant to be overridden. |

```ts sample
import { Command } from '@spinajs/cli';
import { AuthzCliCommand } from '@spinajs/authz-rbac';

/** Prints whether authz boots with the configured role and rule stores; needs no database. */
@Command('authz:boot-check', 'Boots the authz service and reports success')
export class BootCheckCommand extends AuthzCliCommand {
  protected touchesDb(): boolean {
    return false;
  }

  public async execute(): Promise<void> {
    await this.command(
      () => ({}),
      async () => {
        await this.authz();
        this.out('OK: authz booted');
      },
    );
  }
}
```

## Examples

### Create the first administrator

```sh
npx spinajs authz:assign user:5f0c2a7e-0d4b-4a3e-9c1f-2b8d7e6a1c90 admin
```

### Give temporary support access to one org

```sh
npx spinajs authz:assign user:42 support -s org:7 -e 2030-01-31T18:00:00+01:00 -t billing
```

### Find out why a user cannot export a report

```sh
npx spinajs authz:explain user:42 report:export report:9
```

### Check the role config before a deploy

```sh
npx spinajs authz:check-config --explain-role accountant
```

## Related

- [Assigning roles](04-assigning-roles.md): the commands `authz:assign` and `authz:revoke` run.
- [Assigning roles: subject sets](04-assigning-roles.md#teams-groups-and-other-subject-sets): what the membership table holds.
- [`@spinajs/cli`](../cli/README.md): how commands are discovered and run.
