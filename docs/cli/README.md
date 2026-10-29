# `@spinajs/cli`

Builds command line tools from DI-managed classes. You declare a command with `@Command`, `@Argument` and `@Option` on a `CliCommand` subclass, and the `spinajs` bin discovers, parses and runs it on top of [commander](https://github.com/tj/commander.js) 10.

Inside a command you have the whole framework: `@Autoinject`, `@Logger`, configuration and optional `@spinajs/intl` translation.

It does **not** scaffold projects or generate code, and it does **not** import your command files for you unless their directory is listed in `system.dirs.cli`.

## Install

```sh
npm install @spinajs/cli
```

The package ships the `spinajs` bin (`lib/mjs/cli.js`).

## Features

| Feature | What it does |
| --- | --- |
| [Running the CLI](01-running-the-cli.md) | The `spinajs` bin: boot order, framework options, help, version, exit codes, the built-in `configuration:dump` |
| [Commands](02-commands.md) | `CliCommand` and `@Command`: names, aliases, subcommands, how a command is resolved from DI and how to replace one |
| [Arguments and options](03-arguments-and-options.md) | `@Argument` and `@Option`: required, variadic, choices, parsers, env- and config-backed defaults |
| [Lifecycle hooks and commander access](04-lifecycle-hooks.md) | `onCreation`, `onPreAction`, `onPostAction` and the re-exported commander API |
| [Command discovery](05-command-discovery.md) | `system.dirs.cli`: how command files are found, and how a package ships its own commands |
| [Argv provider](06-argv-provider.md) | The `__cli_argv_provider__` factory that hands argv to the parser; replace it for tests and custom entry points |
| [`Cli` service](07-cli-service.md) | The service that builds the command tree and runs it; subclass it, translate help text, run it from your own entry point |

## Quick start

```ts sample
import { Log, Logger } from '@spinajs/log';
import { Autoinject } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';

interface PurgeOptions {
  olderThan: number;
  dryRun?: boolean;
}

// Put this file in a directory listed in `system.dirs.cli`, then run:
//   spinajs sessions:purge web --older-than 30 --dry-run
@Command('sessions:purge', 'Deletes expired sessions of one application')
@Argument('app', true, 'application name')
@Option('-o, --older-than <days>', false, 'age in days', 14, (v) => parseInt(v, 10))
@Option('-d, --dry-run', false, 'only count the sessions')
export class PurgeSessionsCommand extends CliCommand {
  @Logger('sessions')
  protected Log: Log;

  @Autoinject()
  protected Config: Configuration;

  public async execute(app: string, options: PurgeOptions): Promise<void> {
    const store = this.Config.get<string>('session.store', 'memory');
    this.Log.info(`Purging ${app} sessions older than ${options.olderThan} days from ${store}${options.dryRun ? ' (dry run)' : ''}`);
  }
}
```

## Generating typed config paths

`spinajs generate:config-types` reads an application manifest and writes the `ConfigPaths` declarations that type `Configuration.get()` and `@Config()`.

```bash
spinajs generate:config-types --manifest app.manifest.json --out src/spinajs-config.d.ts --modules hooks
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-m, --manifest <path>` | `app.manifest.json` | Manifest to read |
| `-o, --out <path>` | `src/spinajs-config.d.ts` | Declaration file to write |
| `--modules <list>` | all | Comma separated config modules to include; a name the manifest lacks is reported as a warning |

The command needs `@spinajs/compiler`, an optional peer dependency of `@spinajs/cli`; install it to use this command.

## Related packages

- `@spinajs/di`: every command and the `Cli` service are resolved from the DI container.
- `@spinajs/configuration`: loads `system.dirs.cli`, consumes `--app`, `--env` and `--apppath`, and backs `@Option({ configKey })`.
- `@spinajs/reflection`: its `@ListFromFiles` lists the command files.
- `@spinajs/log`: commander errors and the bin's messages go through the framework logger.
- `@spinajs/intl`: optional; when its global `__` works, help text is translated.
- [`@spinajs/orm`](../orm/README.md): its migration commands ship in `@spinajs/orm-cli`, built on this package.

## Built-in generators

| Command | What it does |
| --- | --- |
| `generate:asyncapi` | Reads an application manifest (`--manifest`, default `app.manifest.json`) and writes an AsyncAPI 3.0 document (`--out`, default `asyncapi.json`). Also `--title`, `--doc-version` (`--version` is taken by the root command) and `--server-url`. See [`@spinajs/asyncapi`](../asyncapi/README.md). |
