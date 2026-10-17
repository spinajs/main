# `@spinajs/orm-cli`

Migration commands for the `spinajs` bin: apply, roll back, report, record the outcome of a failed run, and scaffold a new migration. Each command is a thin wrapper over `orm.Migration` (the `MigrationRunner` of [`@spinajs/orm`](../orm/10-migrations.md)); this package adds argument checks, operator-facing wording and exit codes.

It does **not** decide what a migration run does: ordering, batching, locking, transactions and the tracking table all live in `@spinajs/orm`. The dependency runs one way, `orm-cli` to `orm`, so the ORM has no CLI in its dependency tree.

## Install

```sh
npm install @spinajs/orm-cli
```

The package ships a config file that appends its command directory to `system.dirs.cli`. Installing it is enough for `spinajs migrate-status` to work; see [Command discovery](07-command-discovery.md) for the one command that needs a workaround.

## Features

| Feature | What it does |
| --- | --- |
| [Applying migrations](01-applying-migrations.md) | `migrate-up`: applies pending migrations, all or one by name, on every connection or one, for real or `--fake` |
| [Rolling back migrations](02-rolling-back-migrations.md) | `migrate-down`: reverses the last applied batch, or everything with `--all` |
| [Migration status](03-migration-status.md) | `migrate-status`: one line per migration per connection on stdout; exits `1` while anything is pending or failed, so it works as a deploy gate |
| [Resolving failed migrations](04-resolving-failed-migrations.md) | `migrate-resolve`: records whether a failed or interrupted migration reached the database, which unblocks the connection |
| [Scaffolding migrations](05-scaffolding-migrations.md) | `migrate-create`: writes a timestamped migration class file, optionally tagged for one environment |
| [The CLI `Orm`](06-cli-orm.md) | `resolveCliOrm()` and `CLI_ORM_OPTIONS`: the `Orm` every command runs against, with the boot migration pass switched off |
| [Command discovery](07-command-discovery.md) | The `system.dirs.cli` config fragment, how `Cli` finds the commands, and running them without the bin |
| [Customizing commands](08-customizing-commands.md) | Replace or extend a shipped command through DI, override its protected hooks, or build your own command on the exported pieces |

## Quick start

```sh
spinajs migrate-create --name CreateInvoices        # prints ./src/migrations/CreateInvoices_<timestamp>.ts
spinajs migrate-status                              # exit 1: CreateInvoices_... is pending
spinajs migrate-up                                  # applies it
spinajs migrate-status                              # exit 0
```

The same commands are plain DI classes, so a deploy script can run them without commander:

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { MigrateStatusCommand, MigrateUpCommand } from '@spinajs/orm-cli';
import '@spinajs/log';

/** Applies pending migrations, then fails the deploy step if anything is still not applied. */
async function migrateAndCheck(): Promise<void> {
  await DI.resolve(Configuration);

  await (await DI.resolve(MigrateUpCommand)).execute({});
  await (await DI.resolve(MigrateStatusCommand)).execute();

  process.exit(process.exitCode ?? 0);
}

void migrateAndCheck();
```

## Related packages

- [`@spinajs/orm`](../orm/README.md): the `MigrationRunner`, the migration service, the tracking table and the `@Migration` decorator. Read [Migrations](../orm/10-migrations.md) for what each command does to the database.
- [`@spinajs/cli`](../cli/README.md): the `spinajs` bin, `CliCommand`, `@Command`, `@Option` and command discovery.
- [`@spinajs/configuration`](../configuration/README.md): merges this package's `system.dirs.cli` entry and consumes `--env`.
- `@spinajs/log-common`: every command except `migrate-status` reports through the `ORM-CLI` logger.
