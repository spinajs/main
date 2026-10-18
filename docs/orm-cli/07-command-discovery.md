# Command discovery

The package ships a config file that adds its compiled `cli` directory to `system.dirs.cli`. The `spinajs` bin scans that list and turns each command file into a commander command, so installing the package is enough.

## How it works

1. `@spinajs/configuration` loads `node_modules/@spinajs/orm-cli/lib/<mjs|cjs>/config/orm-cli.js` with every other `@spinajs/*` config file.
2. Its default export appends two directories to `system.dirs.cli`; arrays merge by concatenation, so the entries of `@spinajs/cli` and your application stay.
3. `Cli.resolve()` lists every exported class of every file in those directories and keeps the ones decorated with `@Command`. See [`@spinajs/cli`: command discovery](../cli/05-command-discovery.md).
4. `Cli` reads the `@Command` and `@Option` metadata of each kept class and builds the commander command. It resolves the class from DI only when the command is invoked.

| File | Command class | Command |
| --- | --- | --- |
| `cli/MigrateUp.js` | `MigrateUpCommand` | `migrate-up` |
| `cli/MigrateDown.js` | `MigrateDownCommand` | `migrate-down` |
| `cli/MigrateStatus.js` | `MigrateStatusCommand` | `migrate-status` |
| `cli/MigrateResolve.js` | `MigrateResolveCommand` | `migrate-resolve` |
| `cli/MigrateCreate.js` | `MigrateCreateCommand`, next to its constants and helpers | `migrate-create` |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `system.dirs.cli` | `string[]` | appends `<root>/node_modules/@spinajs/orm-cli/lib/<flavour>/cli` and `<root>/../node_modules/@spinajs/orm-cli/lib/<flavour>/cli` | absolute directory paths | Where `Cli` looks for this package's commands. `<root>` is `process.env.WORKSPACE_ROOT_PATH ?? process.cwd()`; `<flavour>` is `cjs` when `module` is defined, else `mjs` |

| Environment variable | Meaning |
| --- | --- |
| `WORKSPACE_ROOT_PATH` | The directory holding `node_modules`, when the process starts elsewhere |

```ts
// lib/mjs/config/orm-cli.js, as shipped
export default {
  system: {
    dirs: {
      cli: [
        '<root>/node_modules/@spinajs/orm-cli/lib/mjs/cli',
        '<root>/../node_modules/@spinajs/orm-cli/lib/mjs/cli',
      ],
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Command directory | Config key `system.dirs.cli`, read once per `Cli` instance | The two paths above | Your own directories, appended by your config | Append a directory that holds your own command files; this package's entries stay, because arrays concatenate |
| `'__cli_command__'` | String token; `@Command` registers each of the five classes under it when the module is evaluated | the five command classes | none | Read-only. `Cli` does not use it, so importing `@spinajs/orm-cli` does not by itself add commands to the bin |

### Run the commands without the bin

Every command is a DI class with an `execute(options)` method. Resolve `Configuration` first, then the command, and read `process.exitCode` afterwards.

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { MigrateCreateCommand, MigrateStatusCommand } from '@spinajs/orm-cli';
import '@spinajs/log';

/** A `db` script: `node db.js new CreateInvoices` or `node db.js status`. */
async function main(): Promise<void> {
  await DI.resolve(Configuration);
  const [action, name] = process.argv.slice(2);

  if (action === 'new') {
    await (await DI.resolve(MigrateCreateCommand)).execute({ name });
  } else {
    await (await DI.resolve(MigrateStatusCommand)).execute();
  }

  process.exit(process.exitCode ?? 0);
}

void main();
```

## Important behaviour

- **Only `lib/` is scanned.** A checkout of this package that was never built has no `lib/<flavour>/cli`, and `Cli` warns `Directory ... not exists`.
- **`<root>` is the working directory.** Start the bin from the directory that holds `node_modules`, from one level below it, or set `WORKSPACE_ROOT_PATH`.
- **Command classes are not instantiated at discovery.** Only the invoked command resolves an `Orm`; `spinajs --help` opens no database connection.
- **The bin exits with `process.exitCode`.** `migrate-up` and `migrate-status` report "not current" through it. A `@spinajs/cli` whose bin ends with a bare `process.exit(0)` loses it; run the classes directly in that case.

## Best practices

- Run `spinajs configuration:dump -p system.dirs.cli` when a command is missing; it prints the directories actually scanned.
- Keep shared base classes of your commands outside your command directories; an undecorated `CliCommand` subclass there is skipped with a warning.

## Patterns and antipatterns

```ts
// Don't: expect a side-effect import to add the commands to the bin; discovery ignores '__cli_command__'
import '@spinajs/orm-cli';

// Do: rely on the shipped system.dirs.cli entry
```

## Related

- [`@spinajs/cli`: command discovery](../cli/05-command-discovery.md): the scanning rules.
- [`@spinajs/cli`: running the CLI](../cli/01-running-the-cli.md): boot order and exit codes of the bin.
- [Customizing commands](08-customizing-commands.md): replacing a shipped command or adding your own.
