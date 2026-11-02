# Command discovery

`Cli` finds commands by scanning the directories listed in the `system.dirs.cli` configuration key. Each `@spinajs` package that ships commands appends its own directory there; your application appends its own the same way.

## How it works

1. **Config merge.** `@spinajs/configuration` loads every config file and concatenates the `system.dirs.*` arrays, so `system.dirs.cli` collects the entries of this package, of every other `@spinajs/*` package and of your app.
2. **Listing.** `Cli.Commands` is a property decorated `@ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.cli')` from `@spinajs/reflection`. Reading it the first time:
   - drops duplicate directories and skips a missing one with the warning `Directory ... not exists`;
   - globs every `.ts` and `.js` file below each directory, recursively, except `.d.ts`;
   - imports each file (`import()`; a registered `'__module_loader__'` takes precedence);
   - returns one `ClassInfo { file, name, type }` per exported class of each file, **without** instantiating it. Constants and arrow functions are not listed.
3. **Filter.** `Cli.resolve()` skips an entry whose `type` is not a function (warning `... has no exported class`) and a class or function without `@Command` metadata. The skip is silent for helpers; a `CliCommand` subclass without the decorator logs the warning `... is not marked as command`. Every other entry becomes a commander command, and `Found command ...` is logged at `info`.
4. **No commands.** An empty list logs `No registered commands found !`; the program is still built, so `--help` and `--version` work.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `system.dirs.cli` | `string[]` | `node_modules/@spinajs/cli/lib/cli` under `process.env.WORKSPACE_ROOT_PATH ?? process.cwd()`, and the same path one directory up | Absolute directory paths | Directories scanned for command files. Each `@spinajs` package that ships commands appends its own |

`WORKSPACE_ROOT_PATH` is an environment variable. Set it when the process runs from a directory other than the one holding `node_modules`.

```ts
// config/cli.ts in your application
import { join, resolve } from 'path';

export default {
  system: {
    dirs: {
      cli: [resolve(join(process.cwd(), 'lib', 'cli'))],
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Command directories | Config key `system.dirs.cli`, read once per `Cli` instance | This package's `cli` directory (holds `configuration:dump`) | Directories appended by `@spinajs/fs`, `@spinajs/http`, `@spinajs/http-swagger`, `@spinajs/email`, `@spinajs/orm-cli`, `@spinajs/templates`, `@spinajs/templates-pdf`, `@spinajs/templates-image`, `@spinajs/tasks`, `@spinajs/users` and others | Append a directory in a config file of your app or package |
| Module loader | String token `'__module_loader__'` in `@spinajs/di`, an object with `load(path)` | none (`import()` / `require()`) | none shipped | `DI.register(loader).asValue('__module_loader__')`; used for every file `@spinajs/di` loads, not only commands |

### Ship commands from your own package

A package adds its commands with a config file compiled to `lib/config/`. `@spinajs/configuration` loads `node_modules/@spinajs/*/lib/config` automatically. A package outside the `@spinajs` scope must have its config directory listed by the application instead.

```ts sample
import { join, normalize, resolve } from 'path';

// src/config/billing.ts of a package published as @spinajs/billing.
// Commands live in src/cli/ and compile to lib/cli/.
function commandDirs(sub: string): string[] {
  const root = process.env.WORKSPACE_ROOT_PATH ?? process.cwd();
  return [
    resolve(normalize(join(root, 'node_modules', '@spinajs', 'billing', 'lib', sub))),
    // one level up, for a process started from an app or build folder
    resolve(normalize(join(root, '..', 'node_modules', '@spinajs', 'billing', 'lib', sub))),
  ];
}

const billing = {
  system: {
    dirs: {
      cli: commandDirs('cli'),
    },
  },
};

export default billing;
```

This mirrors `src/config/cli.ts` of this package and `src/config/orm-cli.ts` of `@spinajs/orm-cli`.

## Important behaviour

- **Every exported command of a file is found.** A file may export several commands, for example a parent and its subcommands, and helpers or constants next to them; the helpers are skipped.
- **No default exports.** When a module has a `default` export, the loader uses it in place of the namespace.
- **Every file is imported.** Module-level code in each file under the directories runs on every `spinajs` call, for every command. Keep imports and top-level code of command files cheap.
- **Commands are not instantiated during discovery.** Only the invoked command and its parents are resolved; see [Commands](02-commands.md#how-it-works).
- **Base classes in the directory.** An abstract, undecorated base class in a scanned directory is listed and skipped with the `not marked as command` warning. Keep it outside the directory to keep the log clean.
- `@Command` also registers the class under `'__cli_command__'`, but discovery does not use that registration: importing a command module without listing its directory does not make the command available.

## Best practices

- Name each command file after its class (`PurgeSessions.ts` exporting `PurgeSessionsCommand`); keep a group of related commands, such as a parent and its subcommands, together in one file when that reads better.
- Point `system.dirs.cli` at compiled output (`lib/cli`) in production, and at `src/cli` only when the process runs through a TypeScript loader.
- Run `spinajs configuration:dump -p system.dirs.cli` when a command is missing; it prints the directories actually scanned.

## Patterns and antipatterns

```ts
// Don't: an undecorated CliCommand subclass in a scanned directory is skipped with a warning
export class PrintCommand extends CliCommand { /* ... */ }

// Do: decorate it, or keep a shared base class outside the commands directory
@Command('print', 'print the report')
export class PrintCommand extends CliCommand { /* ... */ }
```

## Examples

### Application commands next to package commands

```ts sample
import { join, resolve } from 'path';

// config/cli.ts of the application. system.dirs arrays concatenate, so the
// package directories (fs, http, orm-cli, ...) stay in the list.
const config = {
  system: {
    dirs: {
      cli: [resolve(join(process.cwd(), 'lib', 'cli')), resolve(join(process.cwd(), 'lib', 'maintenance'))],
    },
  },
};

export default config;
```

## Related

- [Commands](02-commands.md): what a discovered class must look like.
- [Running the CLI](01-running-the-cli.md): when discovery happens in the bin's boot.
- `@spinajs/reflection`: `@ListFromFiles`, the file lister.
- `@spinajs/configuration`: config file locations and array merging.
