# Command discovery

`Cli` finds commands by scanning the directories listed in the `system.dirs.cli` configuration key. Each `@spinajs` package that ships commands appends its own directory there; your application appends its own the same way.

## How it works

1. **Config merge.** `@spinajs/configuration` loads every config file and merges arrays by concatenation, so `system.dirs.cli` collects the entries of this package, of every other `@spinajs/*` package and of your app.
2. **Listing.** `Cli.Commands` is a property decorated `@ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.cli')` from `@spinajs/reflection`. Reading it the first time:
   - drops duplicate directories and skips a missing one with the warning `Directory ... not exists`;
   - globs every `.ts` and `.js` file below each directory, recursively, except `.d.ts`;
   - imports each file (`import()` in ESM mode, `require()` otherwise; a registered `'__module_loader__'` takes precedence);
   - returns one `ClassInfo { file, name, type }` per file, from the first exported name, **without** instantiating it.
3. **Filter.** `Cli.resolve()` skips an entry with no `type` (warning `... has no exported class`) and a class without `@Command` metadata (warning `... is not marked as command`). Every other entry becomes a commander command, and `Found command ...` is logged at `info`.
4. **No commands.** An empty list logs `No registered commands found !`; the program is still built, so `--help` and `--version` work.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `system.dirs.cli` | `string[]` | `node_modules/@spinajs/cli/lib/<mjs\|cjs>/cli` under `process.env.WORKSPACE_ROOT_PATH ?? process.cwd()`, and the same path one directory up | Absolute directory paths | Directories scanned for command files. Each `@spinajs` package that ships commands appends its own |

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

A package adds its commands with a config file compiled to `lib/<mjs|cjs>/config/`. `@spinajs/configuration` loads `node_modules/@spinajs/*/lib/<mjs|cjs>/config` automatically. A package outside the `@spinajs` scope must have its config directory listed by the application instead.

```ts sample
import { join, normalize, resolve } from 'path';

// src/config/billing.ts of a package published as @spinajs/billing.
// Commands live in src/cli/ and compile to lib/<mjs|cjs>/cli/.
function commandDirs(sub: string): string[] {
  const root = process.env.WORKSPACE_ROOT_PATH ?? process.cwd();
  const flavour = typeof module !== 'undefined' ? 'cjs' : 'mjs';
  return [
    resolve(normalize(join(root, 'node_modules', '@spinajs', 'billing', 'lib', flavour, sub))),
    // one level up, for a process started from an app or build folder
    resolve(normalize(join(root, '..', 'node_modules', '@spinajs', 'billing', 'lib', flavour, sub))),
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

- **One command per file.** Only the first exported name of each file is considered. Under ESM the module namespace lists exports alphabetically, so in a file exporting `DbCommand` and `DbMigrateCommand` only `DbCommand` is found. Put each command in its own file.
- **The first export must be the command.** A file whose alphabetically first export is a helper (`ensureProviders`, an interface constant) yields that helper and the command is skipped. `@spinajs/fs`'s `fs.ts` works only because `FsDescribeCommand` sorts before `ensureProviders`. A primitive first export (`export const VERSION = '1.0'`) is worse: `Reflect.getMetadata` throws a `TypeError` on it and `Cli.resolve()` fails for every command.
- **No default exports.** When a module has a `default` export, the loader uses it in place of the namespace.
- **Every file is imported.** Module-level code in each file under the directories runs on every `spinajs` call, for every command. Keep imports and top-level code of command files cheap.
- **Commands are not instantiated during discovery.** Only the invoked command and its parents are resolved; see [Commands](02-commands.md#how-it-works).
- **Base classes in the directory.** An abstract, undecorated base class in a scanned directory is listed and skipped with the `not marked as command` warning. Keep it outside the directory to keep the log clean.
- `@Command` also registers the class under `'__cli_command__'`, but discovery does not use that registration: importing a command module without listing its directory does not make the command available.

## Best practices

- Name each command file after its class (`PurgeSessions.ts` exporting `PurgeSessionsCommand`) and export nothing else from it.
- Point `system.dirs.cli` at compiled output (`lib/cli`) in production, and at `src/cli` only when the process runs through a TypeScript loader.
- Run `spinajs configuration:dump -p system.dirs.cli` when a command is missing; it prints the directories actually scanned.

## Patterns and antipatterns

```ts
// Don't: two commands in one file; only `ReportDailyCommand` (alphabetically first) is discovered
export class ReportWeeklyCommand extends CliCommand { /* ... */ }
export class ReportDailyCommand extends CliCommand { /* ... */ }

// Do: cli/ReportDaily.ts and cli/ReportWeekly.ts, one exported class each
```

```ts
// Don't: `DEFAULT_COLUMNS` sorts before `PrintCommand`, so the constant is listed and the command is never found
export const DEFAULT_COLUMNS = ['id', 'total'];
export class PrintCommand extends CliCommand { /* ... */ }

// Do: keep helpers in a module outside the commands directory and import them
```

## Examples

### Application commands next to package commands

```ts sample
import { join, resolve } from 'path';

// config/cli.ts of the application. Arrays merge by concatenation, so the
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
