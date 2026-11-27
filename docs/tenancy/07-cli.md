# CLI commands in a tenant

With `@spinajs/tenancy` installed, every `spinajs` command accepts `--tenant <id>` or `--all-tenants <reason>`. A command run with neither has no tenant scope. Nothing is imported by the application: the package's configuration lists its `lib/cli` folder in `system.dirs.cli`, and the CLI imports `TenantCliHook` from there with the commands.

```text
spinajs report:monthly --tenant acme
spinajs data:repair --all-tenants "ticket 4711, broken totals"
spinajs report:monthly                  # no tenant scope: a tenant model throws TenantRequired
```

## How it works

`TenantCliHook` is a `CliCommandHook` of `@spinajs/cli` with `order` `TENANT_CLI_HOOK_ORDER` (`-100`), so hooks of other packages run inside the tenant. Around every command's `execute()`:

1. `--tenant <id>`: `admitTenant(id)` with no principal, then the command runs in `tenantScopeOf(record.id)`.
2. `--all-tenants <reason>`: the reason is trimmed and must not be empty; the command runs in the cross-tenant scope, and an info line `Command <name> runs across all tenants: <reason>` is logged.
3. Neither: the command runs with no scope, also when the process that runs the CLI was inside one.

| Given | Result |
| --- | --- |
| an active tenant's id, exactly as registered | runs inside that tenant |
| an id the registry does not know, or not of the id pattern (`ACME`, ` acme`, `acme `) | `TenantUnavailable` (`unknown`, `no such tenant`); the command does not run |
| a tenant in state `provisioning`, `suspended`, `deleting` or `deleted` | `TenantUnavailable` (`inactive`); the command does not run |
| `--all-tenants` with an empty or blank reason | `InvalidArgument`; the command does not run |
| both options | commander's conflict error; the command does not run |

A refusal is a command error: the bin prints the message and exits with `-1`.

## Important behaviour

- The scope covers `execute()` and the work it starts, also what settles after `execute()` returned. The next command in the same process starts with no scope.
- `onCreation`, `onPreAction`, `onPostAction` and the command's own resolution run outside the scope: tenant models throw there.
- The options belong to the program. A command must not declare `--tenant` or `--all-tenants` itself: its option never receives a value, not even its default. It reads `currentTenant()` or `tenantScope()` instead.
- `admitTenant` gets no principal, so `TenantAccess.canEnter` is not asked: whoever can run the CLI can enter every active tenant, as they hold the application's configuration and database credentials.
- An application that sets `system.dirs.cli` itself replaces the package folders; list `node_modules/@spinajs/tenancy/lib/cli` there too, or a file of your own that imports `@spinajs/tenancy/cli`. Without the hook the two options are unknown and every command that is given one stops.

## Related

- [Tenant admission and access](04-admission-and-access.md): what `admitTenant` checks.
- [Running across tenants](05-running-across-tenants.md): `runAcrossTenants` and `forEachTenant`.
- [`@spinajs/cli` lifecycle hooks](../cli/04-lifecycle-hooks.md): `CliCommandHook`.
