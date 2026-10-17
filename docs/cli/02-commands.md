# Commands

A command is a class that extends `CliCommand`, carries `@Command` and implements `execute()`. The `Cli` service turns its metadata into a commander command and resolves the class from DI only when the command is invoked.

## How it works

1. **Declaration.** `@Command` stores an `ICommand` under the `cli:command` metadata key (`META_COMMAND`) on the class and calls `DI.register(target).as('__cli_command__')`.
2. **Discovery.** `Cli.resolve()` lists the file through `system.dirs.cli` ([Command discovery](05-command-discovery.md)). A listed class without `@Command` metadata is skipped with the warning `Command ... is not marked as command`.
3. **Build.** `Cli.resolve()` creates `new Command(nameAndArgs)` from commander, applies the `ICommand` fields, adds the options and arguments ([Arguments and options](03-arguments-and-options.md)), and registers `preAction`, `postAction` and action handlers.
4. **Tree.** Commands with `parent` are attached to the command whose name matches; the rest go to the top level.
5. **Dispatch.** When commander selects the command, its parent's `preSubcommand` hook calls `DI.resolve(<command class>)` once and calls `onCreation(command)`. The resolved instance is memoized for the run.
6. **Execute.** Commander runs the `preAction` hooks, then `execute(...args, options, command)`, then the `postAction` hooks ([Lifecycle hooks](04-lifecycle-hooks.md)).
7. **Errors.** A failing `DI.resolve()` logs `Cannot resolve command ${command} ( ${file} )` and rejects the run. An error thrown by `execute()` rejects `Cli.resolve()`.

### Arguments of `execute()`

Commander calls `execute` with:

1. One value per `@Argument`, in declaration order (top to bottom). A variadic argument arrives as `string[]`.
2. The options object, keyed by the camel-cased long flag name (`--dry-run` becomes `dryRun`).
3. The commander `Command` object (`CommanderCommand`) that ran.

```ts
@Command('user:rename', 'Renames a user')
@Argument('login', true)
@Argument('newLogin', true)
@Option('-n, --notify', false, 'email the user')
export class RenameUserCommand extends CliCommand {
  public async execute(login: string, newLogin: string, options: { notify?: boolean }, command: CommanderCommand) {}
}
```

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Command(nameAndArgs, description, opts?)` | class | `nameAndArgs`: command name; `description`; `opts`: commander `CommandOptions` (stored, not applied) | Marks the class as a command and registers it under `'__cli_command__'` |
| `@Command(config: ICommand)` | class | every field of `ICommand`, below | Same, with the full option set |

`@Command` is independent of the order of `@Argument` and `@Option` on the same class.

### `ICommand` fields

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `nameAndArgs` | `string` | required | The command name. Its first space-separated token is the name `parent` matches against |
| `description` | `string` | `''` in the positional form | Help description, translated |
| `opts` | `CommandOptions` | `undefined` | Stored in the metadata; `Cli` does not pass it to commander, so `hidden` and `isDefault` have no effect |
| `aliases` | `string[]` | none | Alternative names, eg. `['ls']` |
| `summary` | `string` | none | Short text in the parent's command list, translated |
| `usage` | `string` | generated | Usage line in help |
| `parent` | `string` | none | Name of the parent command; the command is nested under it |
| `allowUnknownOption` | `boolean` | `false` | Accept options not declared on the command |
| `allowExcessArguments` | `boolean` | commander default (`true` in v10) | Accept more operands than declared |
| `passThroughOptions` | `boolean` | `false` | Options after the first operand are passed on as operands |
| `enablePositionalOptions` | `boolean` | `false` | Options are parsed per command level, so a subcommand can reuse a parent's option name |
| `helpText` | `Array<{ position: AddHelpTextPosition; text: string }>` | none | Extra help sections (`'beforeAll'`, `'before'`, `'after'`, `'afterAll'`), translated |
| `configureHelp` | `HelpConfiguration` | none | Commander help formatting, eg. `{ sortOptions: true }` |

## Subcommands

Give the child `parent: '<parent name>'`. Nesting is unlimited, and the file order does not matter: `Cli` builds every command first and assembles the tree afterwards.

```ts
@Command({ nameAndArgs: 'cache', description: 'Cache maintenance' })
export class CacheCommand extends CliCommand {
  public async execute(): Promise<void> {
    console.log('Use: spinajs cache clear | spinajs cache warm');
  }
}

@Command({ nameAndArgs: 'clear', description: 'Clears the cache', parent: 'cache' })
export class CacheClearCommand extends CliCommand { /* spinajs cache clear */ }
```

- A parent is a normal command: it needs `execute()` (abstract on `CliCommand`), and `execute()` runs when the parent is invoked without a subcommand.
- A `parent` that matches no command logs `Parent command ... not found; registering at top level` and the child is registered at the top level.
- `parent` matches the parent's name, never its aliases.
- Every command has an action, and commander 10 allows excess operands by default. `spinajs db vacum` (a typo) therefore runs `db`'s `execute()` with `'vacum'` as an extra operand instead of failing. Set `allowExcessArguments: false` on the parent to turn the typo into an error.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `CliCommand` | Abstract base; each subclass is resolved by its own class with `DI.resolve(type)`, lazily, at most once per run. Lifetime is the class's own: singleton unless the class has `@NewInstance()` or another lifetime decorator | none; every command is user code | Commands shipped by `@spinajs/fs`, `@spinajs/http`, `@spinajs/orm-cli` and others, plus this package's `configuration:dump` | Subclass `CliCommand` and add `@Command`; share code through an abstract undecorated base; swap a shipped command's instance with `DI.register(Sub).as(ShippedCommand)` |
| `'__cli_command__'` | String token; every `@Command` class is registered under it at decoration time | every decorated command class | none | Read-only for you: `Cli` does not resolve it. `DI.getRegisteredTypes('__cli_command__')` lists the command classes imported so far without instantiating them |

### `CliCommand`: what you implement

| Member | Kind | Called by | Default |
| --- | --- | --- | --- |
| `execute(...args)` | abstract, async | the commander action | none; required |
| `onCreation(command)` | hook | parent's `preSubcommand`, before parsing | no-op |
| `onPreAction(thisCommand, actionCommand)` | hook | commander `preAction` | no-op |
| `onPostAction(thisCommand, actionCommand)` | hook | commander `postAction` | no-op |
| `resolve()` | `AsyncService` lifecycle | `DI.resolve()`, before `onCreation` | no-op |

`CliCommand` extends `AsyncService`, so `@Autoinject`, `@Logger`, `@Inject` and an async `resolve()` work like in any service.

### `CliCommand`: a shared base class for a command family

Put shared setup in an abstract base without `@Command`, and decorate only the concrete commands. `@spinajs/authz-orm`'s `AuthzOrmCliCommand` follows this pattern.

```ts sample
import { Log, Logger } from '@spinajs/log';
import { Autoinject } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';

/** Shared setup for every `tenant:*` command. Not decorated, so it is never a command itself. */
export abstract class TenantCommand extends CliCommand {
  @Logger('tenants')
  protected Log: Log;

  @Autoinject()
  protected Config: Configuration;

  protected tenants(): string[] {
    return this.Config.get<string[]>('app.tenants', []);
  }

  protected requireTenant(name: string): void {
    if (!this.tenants().includes(name)) {
      console.error(`Unknown tenant "${name}". Known: ${this.tenants().join(', ')}`);
      process.exitCode = 1;
    }
  }
}

@Command('tenant:list', 'Lists configured tenants')
export class TenantListCommand extends TenantCommand {
  public async execute(): Promise<void> {
    this.tenants().forEach((t) => console.log(t));
  }
}

@Command({ nameAndArgs: 'tenant:suspend', description: 'Suspends a tenant', aliases: ['tenant:off'] })
@Argument('tenant', true, 'tenant name')
@Option('-r, --reason <text>', true, 'reason stored in the audit log')
export class TenantSuspendCommand extends TenantCommand {
  public async execute(tenant: string, options: { reason: string }): Promise<void> {
    this.requireTenant(tenant);
    if (process.exitCode) return;
    this.Log.info(`Suspending ${tenant}: ${options.reason}`);
  }
}
```

Discovery finds every exported command of a file ([Command discovery](05-command-discovery.md#important-behaviour)), so the two commands can share one file. Keep `TenantCommand` outside the scanned directory: an undecorated `CliCommand` subclass there is skipped with the `not marked as command` warning.

### `CliCommand`: replace a shipped command's behaviour

`Cli` builds the commander command from the discovered class's metadata, but gets the instance with `DI.resolve(<discovered class>)`. A registration `.as(<discovered class>)` therefore swaps the code that runs while the name, arguments and options stay the same.

Register the replacement before `Cli.resolve()` dispatches, in your own entry point ([`Cli` service](07-cli-service.md#run-the-cli-from-your-own-entry-point)). Keep the subclass out of every `system.dirs.cli` directory: it inherits the `@Command` metadata, so discovery would add it as a second command with the same name.

```ts sample
import { DI } from '@spinajs/di';
import { MigrateUpCommand, IMigrateUpCommandOptions } from '@spinajs/orm-cli';

/** Runs the shipped `migrate-up` and appends an audit line. */
export class AuditedMigrateUpCommand extends MigrateUpCommand {
  public async execute(options: IMigrateUpCommandOptions): Promise<void> {
    const startedAt = new Date().toISOString();
    await super.execute(options);
    console.log(`[audit] migrate-up started ${startedAt} by ${process.env.USER ?? 'unknown'}, fake=${options.fake === true}`);
  }
}

// In your entry point, before `DI.resolve(Cli)`:
DI.register(AuditedMigrateUpCommand).as(MigrateUpCommand);
```

## Important behaviour

- Put only the command name in `nameAndArgs` and declare operands with `@Argument`. `Cli` passes the whole string to `new Command(...)`, which takes it as the name: `@Command('greet <name>', ...)` produces a command called `greet <name>` that `spinajs greet World` cannot invoke.
- Commands are resolved lazily. Unrelated commands are never instantiated, so a command whose `resolve()` throws breaks only its own invocation.
- The parents on the dispatch path are resolved too: `spinajs db migrate` resolves `db` (its `onCreation` and hooks run) before `migrate`.
- `@Option` and `@Argument` read inherited metadata with `Reflect.hasMetadata` and append to that array. A subclass of a decorated command that adds its own `@Option` or `@Argument` mutates the parent command's list, so both commands get the new option. Extend undecorated abstract bases instead.
- Two commands with the same name are both added; commander dispatches to the first one registered.
- Command descriptions, summaries and help texts go through the [translator](07-cli-service.md#translation) once, when the tree is built.

## Best practices

- Name commands `<area>:<verb>` (`configuration:dump`, `tenant:suspend`), or group them under a parent command when there are more than a few in one area.
- Keep constructors and property initializers free of side effects; do I/O in `execute()` or `resolve()`.
- Write data a script consumes to stdout with `console.log`; use `@Logger` for diagnostics. Log levels and targets can hide logger output.

## Patterns and antipatterns

```ts
// Don't: the args in the name become part of the command name, and `spinajs report daily` is an unknown command
@Command('report <period>', 'Prints a report')
export class ReportCommand extends CliCommand {}

// Do
@Command('report', 'Prints a report')
@Argument({ name: 'period', required: true, choices: ['daily', 'weekly'] })
export class ReportCommand extends CliCommand {}
```

```ts
// Don't: extending a decorated command and adding @Option leaks `--format` into `report` as well
@Command('report:csv', 'Prints a CSV report')
@Option('--format <f>', false)
export class CsvReportCommand extends ReportCommand {}

// Do: share an undecorated abstract base
export abstract class ReportBase extends CliCommand {}
@Command('report', 'Prints a report') export class ReportCommand extends ReportBase {}
@Command('report:csv', 'Prints a CSV report') @Option('--format <f>', false) export class CsvReportCommand extends ReportBase {}
```

## Examples

### Group database commands under one parent

```ts sample
import { Log, Logger } from '@spinajs/log';
import { CliCommand, Command, Option } from '@spinajs/cli';

// spinajs db              -> prints the hint
// spinajs db vacuum -f    -> runs DbVacuumCommand
@Command({
  nameAndArgs: 'db',
  description: 'Database maintenance',
  helpText: [{ position: 'after', text: '\nExamples:\n  $ spinajs db vacuum --full' }],
})
export class DbCommand extends CliCommand {
  public async execute(): Promise<void> {
    console.log('Run `spinajs db --help` to list database commands.');
  }
}

// In its own file in the same commands directory.
@Command({ nameAndArgs: 'vacuum', description: 'Reclaims free pages', parent: 'db', aliases: ['compact'] })
@Option('-f, --full', false, 'rebuild the whole file')
export class DbVacuumCommand extends CliCommand {
  @Logger('db')
  protected Log: Log;

  public async execute(options: { full?: boolean }): Promise<void> {
    this.Log.info(options.full ? 'VACUUM FULL' : 'VACUUM');
  }
}
```

## Related

- [Arguments and options](03-arguments-and-options.md): `@Argument` and `@Option`.
- [Lifecycle hooks and commander access](04-lifecycle-hooks.md): `onCreation`, `onPreAction`, `onPostAction`.
- [Command discovery](05-command-discovery.md): where command files come from.
