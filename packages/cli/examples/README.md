# `@spinajs/cli` examples

Each file is a self-contained command (or group of commands) showing one set of
features. They import from `@spinajs/cli` exactly as application code would.

| File | Shows |
| --- | --- |
| [01-basic.ts](01-basic.ts) | positional `@Command` / `@Argument` / `@Option`, a parser, logging |
| [02-choices-variadic.ts](02-choices-variadic.ts) | object-form decorators, `choices`, a variadic argument |
| [03-subcommands.ts](03-subcommands.ts) | nested commands via `parent`, command `aliases` |
| [04-hooks-and-oncreation.ts](04-hooks-and-oncreation.ts) | `onPreAction` / `onPostAction` hooks, `onCreation` escape hatch |
| [05-config-and-env.ts](05-config-and-env.ts) | options backed by `configKey` and `env` |
| [06-advanced-options.ts](06-advanced-options.ts) | `conflicts`, negatable (`--no-x`) and optional-value (`--x [val]`) options with `preset` |

## Running an example

Commands are auto-discovered from the directories listed under the
`system.dirs.cli` configuration key. Point it at this folder (or copy a file
into your own commands directory):

```ts
{
  system: {
    dirs: {
      cli: [ '/abs/path/to/@spinajs/cli/examples' ],
    },
  },
}
```

Then invoke through the `spinajs` bin, e.g.:

```bash
spinajs greet World --loud --repeat 3
spinajs build api web --target prod
spinajs db migrate
```
