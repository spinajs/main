# `@spinajs/cli`

SpinaJS command line module. Build CLI commands as DI-managed classes using
decorators — with full access to SpinaJS features (dependency injection,
logging, configuration, intl) inside your command code.

Built on top of [commander](https://github.com/tj/commander.js).

## Installation

```bash
npm install @spinajs/cli
```

## Writing a command

A command is a class extending `CliCommand`, decorated with `@Command` and
(optionally) `@Argument` / `@Option`. The `execute` method receives the
parsed arguments in declaration order, followed by an options object.

```ts
import { Log, Logger } from '@spinajs/log';
import { CliCommand, Command, Argument, Option } from '@spinajs/cli';

interface GreetOptions {
  loud: boolean;
}

@Command('greet', 'Greets a user')
@Argument('name', true, 'who to greet')
@Option('-l, --loud', false, 'shout the greeting', false)
export class GreetCommand extends CliCommand {
  @Logger('greet')
  protected Log: Log;

  public async execute(name: string, options: GreetOptions): Promise<void> {
    const msg = `Hello, ${name}!`;
    this.Log.info(options.loud ? msg.toUpperCase() : msg);
  }
}
```

### Decorators

Each decorator has a **positional** form (simple cases) and an **object** form
(full configuration). The two are equivalent:

```ts
// positional
@Option('-t, --timeout <ms>', true, 'request timeout', undefined, (v) => parseInt(v))

// object form — unlocks choices / env / configKey
@Option({ flags: '-t, --timeout <ms>', required: true, description: 'request timeout', parser: (v) => parseInt(v) })
```

| Decorator | Positional signature |
| --- | --- |
| `@Command` | `(nameAndArgs, description, opts?)` |
| `@Argument` | `(name, required, description?, defaultValue?, parser?)` |
| `@Option` | `(flags, required?, description?, defaultValue?, parser?)` |

**`@Command` object form** — `{ nameAndArgs, description, ... }`:

| Field | Effect |
| --- | --- |
| `aliases` | alternate names the command can be invoked by |
| `summary` | short text shown in the parent command list |
| `usage` | custom usage string |
| `parent` | nest this command under another (matched by the parent's first name token) |
| `allowUnknownOption` / `allowExcessArguments` | relax parsing |
| `passThroughOptions` / `enablePositionalOptions` | positional/pass-through option handling |
| `helpText` | extra help sections — `[{ position, text }]` (commander `addHelpText`) |
| `configureHelp` | customize help formatting (commander `configureHelp`) |

**`@Argument` object form** — `{ name, required, ... }`:

| Field | Effect |
| --- | --- |
| `choices` | restrict the value to an enum set (validated) |
| `variadic` | collect multiple values into an array (`name...`) |
| `defaultValue` / `parser` | as in the positional form |

**`@Option` object form** — `{ flags, required, ... }`:

| Field | Effect |
| --- | --- |
| `choices` | restrict the value to an enum set (validated) |
| `env` | read the value from an environment variable when not passed |
| `configKey` | fall back to a `@spinajs/configuration` value as the default |
| `conflicts` | option name(s) this option cannot be combined with |
| `implies` | other option values implied when this option is set |
| `preset` | value used for an optional-value option (`--x [val]`) given without a value |
| `defaultValue` / `parser` | as in the positional form |

Negatable (`--no-sauce`) and optional-value (`--cheese [type]`) options need no
extra fields — express them in the `flags` string; commander handles the rest.

Notes:
- `required` arguments render as `<name>`, optional ones as `[name]`; `variadic` appends `...`.
- A `parser` converts the raw string value, e.g. `(v) => parseInt(v)`.
- A required `@Option` cannot have a default value (incl. `configKey`) — it is ignored with a warning.

### Subcommands

Nest commands by giving a child the parent's name via `parent`:

```ts
@Command({ nameAndArgs: 'db', description: 'database commands' })
export class DbCommand extends CliCommand { /* ... */ }

@Command({ nameAndArgs: 'migrate', description: 'run migrations', parent: 'db' })
export class DbMigrateCommand extends CliCommand { /* ... */ }
// invoked as:  spinajs db migrate
```

### Lifecycle hooks

Override `onCreation`, `onPreAction`, or `onPostAction` to tap into the command
lifecycle. `onCreation` hands you the raw commander `Command` for anything the
decorators don't cover:

```ts
export class GreetCommand extends CliCommand {
  public onCreation(command: CommanderCommand): void {
    command.addHelpText('after', '\nExample: spinajs greet World');
  }

  public onPreAction(): void { /* runs before execute */ }
  public onPostAction(): void { /* runs after execute */ }

  public async execute(): Promise<void> { /* ... */ }
}
```

### Using commander directly

The commander surface is re-exported from `@spinajs/cli` so you don't need a
direct dependency on commander. The `Command`/`Option`/`Argument` classes are
aliased (`CommanderCommand`, `CommanderOption`, `CommanderArgument`) to avoid
colliding with the decorators of the same name.

## Registering commands

Commands are auto-discovered from the directories listed under the
`system.dirs.cli` configuration key:

```ts
{
  system: {
    dirs: {
      cli: [ '/abs/path/to/commands' ],
    },
  },
}
```

## Running

The package ships a `spinajs` bin:

```bash
spinajs greet World --loud
spinajs --version
spinajs --help
```

The following framework options are consumed by `@spinajs/configuration`
(not by your commands) and are stripped before parsing:

| Option | Purpose |
| --- | --- |
| `--app <name>` | select the running app |
| `--env <name>` | select the environment |
| `--apppath <path>` | override the app base directory |

## Framework integration

The wrapper wires commander into the rest of SpinaJS:

- **Logging** — commander's error output (and after-error help) is routed
  through `@spinajs/log` (`Log.error`); `--help`/`--version` still print to
  stdout. Unknown commands/options get "did you mean" suggestions.
- **Configuration** — options can fall back to a config value via `configKey`,
  and framework options (`--app`/`--env`/`--apppath`) are consumed by
  `@spinajs/configuration` and stripped before parsing.
- **Internationalization** — when `@spinajs/intl` is present and configured,
  command/option/argument descriptions are translated through its global `__`.
  This is optional: without intl, text is used as-is (no hard dependency).
- **Versioning** — `--version` reports the installed `@spinajs/cli` version.

## Built-in commands

| Command | Description |
| --- | --- |
| `configuration:dump [-p, --path <path>]` | Dumps the resolved configuration (optionally a sub-path) |
