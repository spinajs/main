# `Cli` service

`Cli` is the `AsyncService` that does the whole job: its `resolve()` lists the command files, builds the commander program, parses argv and runs the chosen command. Resolving `Cli` from DI therefore runs the CLI. Subclass it to change translation or wrap the run, and resolve it yourself to build your own entry point.

## How it works

`DI.resolve(Cli)` calls `Cli.resolve()`:

1. `await super.resolve()`, then `await this.Commands` ([Command discovery](05-command-discovery.md)).
2. Creates the program: name `spinajs`, description `SpinaJS command line interface`, version from `@spinajs/cli/package.json` (`0.0.0` when not found).
3. Routes commander's error output to `this.Log.error()` with `configureOutput({ writeErr })` on the program and every command; help and version still go to stdout. Enables `showSuggestionAfterError` everywhere and `showHelpAfterError` on the program.
4. Builds one commander command per discovered class ([Commands](02-commands.md), [Arguments and options](03-arguments-and-options.md)), passing every description, summary and help text through `translate()`. Calls `exitOverride()` on each, so commander throws instead of calling `process.exit()`.
5. Assembles the tree by `parent`, then registers a `preSubcommand` hook on the program and every command that resolves the selected command and calls its `onCreation` ([Lifecycle hooks](04-lifecycle-hooks.md)).
6. Resolves the [argv provider](06-argv-provider.md). With no command arguments it prints the help and returns.
7. `await program.parseAsync(argv)`. A `CommanderError` with `exitCode` `0` (help, version) is swallowed; every other error is rethrown to the caller of `DI.resolve(Cli)`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `Cli` | Class token `Cli`; no lifetime decorator, so a singleton in the container that resolves it; resolved by type with `DI.resolve(Cli)` in the bin | `Cli` | none shipped | `DI.register(MyCli).as(Cli)` before `DI.resolve(Cli)`, which in practice means your own entry point. Override `translate()` or wrap `resolve()` |
| Translator | Global function `globalThis.__`, installed by `@spinajs/intl` at import | none: `Cli.translate()` returns the text unchanged | `@spinajs/intl` | Install `@spinajs/intl` and resolve `Intl` before `Cli`, or override `Cli.translate()` |
| `Configuration` | `@Autoinject()` into `Cli.Configuration`; class token from `@spinajs/configuration` | `FrameworkConfiguration` (`@spinajs/configuration`) | Any registration `.as(Configuration)` | Used for `system.dirs.cli` and `@Option({ configKey })`; replace it as described in `@spinajs/configuration` |

### Members

| Member | Visibility | Use |
| --- | --- | --- |
| `resolve(): Promise<void>` | public | Builds and runs the CLI. Override and call `super.resolve()` to run code before or after the command |
| `Commands: Promise<ClassInfo<CliCommand>[]>` | public | The discovered command files, not instantiated. Read it to list commands without running one |
| `translate(text?: string): string` | protected | Translates one help string; returns `''` for an empty input |
| `Log: Log` | protected | Logger named `CLI` |
| `Configuration: Configuration` | protected | Injected configuration |

### Translation

`translate()` checks `globalThis.__`. When it is a function, `translate()` returns `__(text)`; when it is missing or throws, it returns `text`. `@spinajs/intl` installs `__` at import time, but `__` throws until the `Intl` service is resolved.

- Translated: command `description`, `summary`, `helpText` entries, option and argument descriptions.
- Not translated: `usage`, aliases, flags, choices, and commander's own messages.
- The `spinajs` bin does not resolve `Intl` before `Cli` builds the tree, so help text stays untranslated there unless something earlier in the boot resolved it. Run `Cli` from your own entry point after `await DI.resolve(Intl)` to translate help.

### `Cli`: custom implementation

Subclass `Cli` when you need to:

- translate help through something other than `@spinajs/intl`;
- run code around every command (timing, audit, telemetry), using `super.resolve()` as the run;
- list commands without running them, through `Commands`.

The program name, description and version are set inside `resolve()` and are not configurable.

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Cli, CommanderError } from '@spinajs/cli';
import '@spinajs/log';

/** Polish help texts for an internal operations tool, and one audit line per run. */
const PL: Record<string, string> = {
  'Deletes expired sessions of one application': 'Usuwa wygasłe sesje aplikacji',
  'application name': 'nazwa aplikacji',
};

export class OpsCli extends Cli {
  protected translate(text?: string): string {
    const base = super.translate(text);
    return PL[base] ?? base;
  }

  public async resolve(): Promise<void> {
    const startedAt = Date.now();
    try {
      await super.resolve();
    } finally {
      this.Log.info(`ops-cli: ${process.argv.slice(2).join(' ')} took ${Date.now() - startedAt} ms`);
    }
  }
}

export async function main(): Promise<void> {
  DI.setESMModuleSupport();
  DI.register(() => process.argv).as('__cli_argv_provider__');
  DI.register(OpsCli).as(Cli);

  await DI.resolve(Configuration);

  try {
    await DI.resolve(Cli); // resolves OpsCli
    process.exit(process.exitCode ?? 0);
  } catch (err) {
    if (!(err instanceof CommanderError)) {
      console.error((err as Error).message);
    }
    process.exit(1);
  }
}
```

## Run the CLI from your own entry point

The `spinajs` bin registers its argv provider, runs bootstrappers, resolves `Configuration` and then `Cli`, in that order. Your own bin does the same, and can add registrations in between: a `Cli` subclass, a replacement for a shipped command ([Commands](02-commands.md#clicommand-replace-a-shipped-commands-behaviour)), test doubles, a resolved `Intl`.

```ts sample
#!/usr/bin/env node
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Cli, CommanderError } from '@spinajs/cli';
import '@spinajs/log';

/** Bin of an app that ships as `acme`: same flow as `spinajs`, a different exit code policy. */
async function acme(): Promise<void> {
  DI.setESMModuleSupport();

  // Same filter as the spinajs bin: these options belong to @spinajs/configuration.
  DI.register(() => {
    const out: string[] = [];
    for (let i = 0; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (['--app', '--env', '--apppath'].some((o) => arg.startsWith(`${o}=`))) continue;
      if (['--app', '--env', '--apppath'].includes(arg)) {
        i++;
        continue;
      }
      out.push(arg);
    }
    return out;
  }).as('__cli_argv_provider__');

  try {
    for (const b of DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }
    await DI.resolve(Configuration);
    await DI.resolve(Cli);
    process.exit(process.exitCode ?? 0);
  } catch (err) {
    if (!(err instanceof CommanderError)) {
      console.error(err);
    }
    process.exit(err instanceof CommanderError ? 2 : 1);
  }
}

void acme();
```

## Important behaviour

- `Cli` is a singleton: one `DI.resolve(Cli)` per container runs the CLI once. Clear the DI cache to run it again in the same process.
- `DI.register(X).as(Cli)` must happen before the first `DI.resolve(Cli)`. The `spinajs` bin resolves `Cli` right after the configuration, before any of your code is imported, so a `Cli` replacement needs your own entry point.
- Errors reach the caller of `DI.resolve(Cli)` as rejections; `Cli` never calls `process.exit()`.
- Commander's messages are logged through `Log.error()` of the `CLI` logger. With a log configuration that filters `error` for `CLI`, parse errors are silent.
- `Commands` lists the files once per `Cli` instance; the promise is cached.

## Best practices

- Copy the bin's sequence (argv provider, bootstrappers, configuration, `Cli`) in your own entry point, and add registrations before `DI.resolve(Cli)`.
- Override `translate()` and call `super.translate()` first, so `@spinajs/intl` still applies when it is configured.

## Related

- [Running the CLI](01-running-the-cli.md): the stock bin.
- [Argv provider](06-argv-provider.md): what `Cli` parses.
- [Commands](02-commands.md): how commands are resolved and replaced.
- `@spinajs/intl`: the global `__` translator.
