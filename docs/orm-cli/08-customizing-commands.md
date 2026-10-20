# Customizing commands

Each command is a `CliCommand` subclass that `Cli` resolves from DI by its own class. You can swap a shipped command for a subclass, override the protected hooks it exposes, or write a new command on `resolveCliOrm()` and the exported helpers.

## How it works

1. `@Command` on each class stores the command metadata and registers the class under `'__cli_command__'`.
2. `Cli` builds the commander command from the metadata of the class it discovered, for example `MigrateUpCommand`.
3. When the command is invoked, `Cli` calls `DI.resolve(MigrateUpCommand)`. A registration `DI.register(Sub).as(MigrateUpCommand)` makes DI return `Sub` instead.
4. Commander calls `execute(options)` on that instance. Name, description and options stay those of the shipped command.

The replacement must be registered before `Cli` dispatches, in your own CLI entry point; see [`@spinajs/cli`: run the CLI from your own entry point](../cli/07-cli-service.md#run-the-cli-from-your-own-entry-point).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `MigrateUpCommand` | Class token, singleton (no lifetime decorator); also `'__cli_command__'` | `MigrateUpCommand` | none shipped | `DI.register(Sub).as(MigrateUpCommand)`. Hooks: `execute(options)`, `reportRun(orm, executed, options)`, `explainEmptyNamedRun(orm, name, connection?)`, `checkModelTables(orm, fake?)`, `Log` |
| `MigrateDownCommand` | Class token, singleton; also `'__cli_command__'` | `MigrateDownCommand` | none shipped | `DI.register(Sub).as(MigrateDownCommand)`. Hooks: `execute(options)`, `announce(options)` (runs before `down()`; throw to veto), `Log` |
| `MigrateStatusCommand` | Class token, singleton; also `'__cli_command__'` | `MigrateStatusCommand` | none shipped | `DI.register(Sub).as(MigrateStatusCommand)`. Hooks: `execute()`, `state(entry)`, `explainFailed(failed)`, `explainInterrupted(interrupted)` |
| `MigrateResolveCommand` | Class token, singleton; also `'__cli_command__'` | `MigrateResolveCommand` | none shipped | `DI.register(Sub).as(MigrateResolveCommand)`. Hooks: `execute(options)`, `action(options)` (runs before the `Orm` is resolved), `Log` |
| `MigrateCreateCommand` | Class token, singleton; also `'__cli_command__'` | `MigrateCreateCommand` | none shipped | `DI.register(Sub).as(MigrateCreateCommand)`. Hooks: `execute(options)`, `Log`. The template is not overridable on the class |
| Your own command | Your class token; discovered from your `system.dirs.cli` | none | none | Extend `CliCommand`, call `resolveCliOrm()`, reuse the exported constants and functions |

`Log` is a `@Logger('ORM-CLI')` property on every command except `MigrateStatusCommand`. Configure the `ORM-CLI` logger name in your log rules to route or silence command messages; `migrate-status` output and the `migrate-create` path go to stdout regardless.

### Hooks per command

| Command | Protected member | Called | Default behaviour |
| --- | --- | --- | --- |
| `MigrateUpCommand` | `reportRun(orm: Orm, executed: OrmMigration[], options: IMigrateUpCommandOptions): Promise<void>` | after every `orm.Migration.up()` | Logs what was applied or recorded, or that nothing is pending; calls `explainEmptyNamedRun()` for an empty named run |
| `MigrateUpCommand` | `explainEmptyNamedRun(orm: Orm, name: string, connection?: string): Promise<void>` | `--name` given and nothing applied | Looks the migration up in `orm.Migration.status()`, logs why it did not run, sets `process.exitCode = 1` unless applied |
| `MigrateUpCommand` | `checkModelTables(orm: Orm, fake?: boolean): Promise<void>` | after `reportRun()`, only without `--name` and `--connection` | Returns when `orm.StrictTableCheck` is `false`; otherwise calls `orm.reloadTableInfo({ strict: true })`, logs a missing table at error level and sets `process.exitCode = 1` |
| `MigrateDownCommand` | `announce(options: IMigrateDownCommandOptions): void` | after `resolveCliOrm()`, before `orm.Migration.down()` | Logs the scope about to be reversed |
| `MigrateStatusCommand` | `state(e: IMigrationStatusEntry): string` | once per table line | `FAILED`, `applied`, `INTERRUPTED`, `rolled-back` or `pending` |
| `MigrateStatusCommand` | `explainFailed(failed: IMigrationStatusEntry[]): void` | at least one failed entry | Prints the blocking warning and two `migrate-resolve` invocations per entry |
| `MigrateStatusCommand` | `explainInterrupted(interrupted: IMigrationStatusEntry[]): void` | at least one interrupted entry | Prints the re-run warning, the start time and two `migrate-resolve` invocations per entry |
| `MigrateResolveCommand` | `action(options: IMigrateResolveCommandOptions): MigrationResolveAction` | first, before `resolveCliOrm()` | Maps the flags to `'applied'` or `'rolled-back'`; throws `InvalidArgument` on both or neither |

Complete samples for each hook are on the command's page: [`migrate-up`](01-applying-migrations.md#migrateupcommand-refuse-to-migrate-production-without-a-confirmation), [`migrate-down`](02-rolling-back-migrations.md#migratedowncommand-veto-a-full-rollback-in-production), [`migrate-status`](03-migration-status.md#migratestatuscommand-point-operators-at-your-runbook), [`migrate-resolve`](04-resolving-failed-migrations.md#migrateresolvecommand-keep-an-audit-trail-of-manual-resolutions), [`migrate-create`](05-scaffolding-migrations.md#migratecreatecommand-open-the-new-file-in-the-editor).

### Replace several commands from your own entry point

```ts sample
#!/usr/bin/env node
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Cli } from '@spinajs/cli';
import { IMigrationStatusEntry } from '@spinajs/orm';
import { IMigrateUpCommandOptions, MigrateStatusCommand, MigrateUpCommand } from '@spinajs/orm-cli';
import '@spinajs/log';

/** Prints `pending` rows in upper case so they stand out in a long report. */
class LoudMigrateStatusCommand extends MigrateStatusCommand {
  protected state(e: IMigrationStatusEntry): string {
    const state = super.state(e);
    return state === 'pending' ? 'PENDING' : state;
  }
}

/** Tags every migrate-up with the deploy id from CI. */
class TaggedMigrateUpCommand extends MigrateUpCommand {
  public async execute(options: IMigrateUpCommandOptions): Promise<void> {
    this.Log.info(`deploy ${process.env.DEPLOY_ID ?? 'local'}: migrate-up starting`);
    await super.execute(options);
  }
}

async function acme(): Promise<void> {
  DI.setESMModuleSupport();
  DI.register(LoudMigrateStatusCommand).as(MigrateStatusCommand);
  DI.register(TaggedMigrateUpCommand).as(MigrateUpCommand);

  for (const b of DI.resolve(Array.ofType(Bootstrapper))) {
    await b.bootstrap();
  }
  await DI.resolve(Configuration);
  await DI.resolve(Cli);
  process.exit(process.exitCode ?? 0);
}

void acme();
```

This entry point skips the `spinajs` bin's argv provider. Register one as in [`@spinajs/cli`: argv provider](../cli/06-argv-provider.md) when you pass `--env` or `--app`.

### Write a new command on the CLI `Orm`

A command of your own gets the same safe `Orm` through `resolveCliOrm()`. This one prints the status as JSON for a dashboard and keeps the deploy-gate exit code.

```ts sample
import { CliCommand, Command, Option } from '@spinajs/cli';
import { resolveCliOrm } from '@spinajs/orm-cli';

// spinajs migrate-status:json --connection reporting
@Command('migrate-status:json', 'Prints migration status as JSON, one object per migration')
@Option('-c, --connection [connection]', false, 'only this connection')
export class MigrateStatusJsonCommand extends CliCommand {
  public async execute(options: { connection?: string }): Promise<void> {
    const orm = await resolveCliOrm();
    const entries = (await orm.Migration.status()).filter((e) => !options.connection || e.connection === options.connection);

    console.log(JSON.stringify(entries.map((e) => ({ name: e.name, connection: e.connection, applied: e.applied, failed: e.failed, interrupted: e.interrupted, pending: e.pending, batch: e.batch, checksumMismatch: e.checksumMismatch })), null, 2));

    if (entries.some((e) => e.failed || e.pending)) {
      process.exitCode = 1;
    }
  }
}
```

Put it in its own file in a directory your application lists in `system.dirs.cli`.

## Important behaviour

- **Keep a replacement subclass out of `system.dirs.cli`.** It inherits the shipped `@Command` metadata, so discovery would add a second command with the same name, and commander runs the first one registered.
- **Do not add `@Option` to a subclass of a shipped command.** `@Option` appends to the inherited metadata array, so the new option leaks into the shipped command too. Declare a new command on `CliCommand` instead.
- **Register before `Cli` dispatches.** Commands resolve lazily; a registration made after the command was resolved is ignored for that run.
- **`migrationTemplate()` and `resolveCliOrm()` are imported directly by the commands.** Replacing them on a subclass or in DI changes nothing; override `execute()` or write a new command.
- **A command of your own gets no table check.** The CLI `Orm` only warns about a missing table; call `orm.reloadTableInfo({ strict: true })` after `orm.Migration.up()` when the command must fail like `migrate-up` does.
- **Commands are singletons.** State kept on a command instance survives between calls in the same process, which matters when a script calls `execute()` twice.

## Best practices

- Call `super` in an overridden hook unless you mean to drop the shipped wording; the shipped messages carry the recovery commands operators rely on.
- Report "not current" with `process.exitCode = 1` and errors by throwing, like the shipped commands; the bin maps them to `1` and `-1`.
- Write machine-readable output with `console.log` and diagnostics through `this.Log`.

## Patterns and antipatterns

```ts
// Don't: a subclass with its own @Option in a scanned directory; it duplicates `migrate-up`
// and adds `--ticket` to the shipped command as well
@Option('--ticket <id>', true)
export class TicketMigrateUpCommand extends MigrateUpCommand {}

// Do: a new command, with its own name and options, that reuses the CLI Orm
@Command('migrate-up:ticket', 'Applies pending migrations for a change ticket')
@Option('--ticket <id>', true)
export class TicketMigrateUpCommand extends CliCommand {
  public async execute(options: { ticket: string }): Promise<void> {
    const orm = await resolveCliOrm();
    await orm.Migration.up();
  }
}
```

## Related

- [`@spinajs/cli`: commands](../cli/02-commands.md#services-and-extension-points): `CliCommand`, its lifecycle hooks, and the general replacement rules.
- [The CLI `Orm`](06-cli-orm.md): what `resolveCliOrm()` returns and how to replace the `Orm`.
- [Command discovery](07-command-discovery.md): where command files must live.
