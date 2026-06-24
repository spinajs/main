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

| Decorator | Signature |
| --- | --- |
| `@Command` | `(nameAndArgs, description, opts?)` |
| `@Argument` | `(name, required, description?, defaultValue?, parser?)` |
| `@Option` | `(flags, required?, description?, defaultValue?, parser?)` |

- `required` arguments render as `<name>`, optional ones as `[name]`.
- A `parser` converts the raw string value, e.g. `(v) => parseInt(v)`.
- A required `@Option` cannot have a default value — one will be ignored with a warning.

For advanced commander features, override `onCreation(command)` to configure
the underlying commander `Command` directly.

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

## Built-in commands

| Command | Description |
| --- | --- |
| `configuration:dump [-p, --path <path>]` | Dumps the resolved configuration (optionally a sub-path) |
