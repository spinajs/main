# Arguments and options

`@Argument` declares a positional operand and `@Option` declares a flag. Both decorate the command class, both come in a positional form for simple cases and an object form for every setting, and `Cli` turns each one into a commander `Argument` or `Option`.

## How it works

1. **Declaration.** Each decorator pushes an `IArgument` or `IOption` onto the class metadata (`cli:argument` / `cli:options`). Stacked decorators run bottom-up, so they `unshift` and the list keeps the top-to-bottom order you wrote.
2. **Option build.** For each `IOption`, `Cli.resolve()` creates `new Option(flags, translate(description))` and applies, in this order: `choices`, `parser`, `env`, `conflicts`, `implies`, `preset`. With both `choices` and `parser`, the raw value is checked against `choices` first and then passed to `parser`.
3. **Option default.** `Cli` takes `defaultValue`; when it is `undefined` and `configKey` is set, it takes `Configuration.get(configKey)`. A required option gets `makeOptionMandatory(true)` and no default (a default is dropped with the warning `Option ... is required; ignoring its default value`). Otherwise a defined default is set with `opt.default()`.
4. **Argument build.** For each `IArgument`, a name without brackets becomes `<name>` when `required`, `[name]` otherwise, with `...` appended when `variadic`. A name that already starts with `<` or `[` and ends with `>` or `]` is used as written. Then `choices`, `parser` and `defaultValue` are applied, `choices` and `parser` combined as for options.
5. **Parsing.** Commander validates and converts the values and passes them to `execute(...arguments, options, command)`. A violation throws a `CommanderError`; see [Running the CLI](01-running-the-cli.md#exit-codes).

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Argument(name, required, description?, defaultValue?, parser?)` | class | positional form | Adds an operand |
| `@Argument(config: IArgument)` | class | every `IArgument` field | Adds an operand with `choices` or `variadic` |
| `@Option(flags, required?, description?, defaultValue?, parser?)` | class | positional form | Adds a flag |
| `@Option(config: IOption)` | class | every `IOption` field | Adds a flag with `choices`, `env`, `configKey`, `conflicts`, `implies` or `preset` |

### `IArgument`

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `name` | `string` | required | Operand name; brackets in the name override `required` and `variadic` |
| `description` | `string` | none | Help text, translated |
| `required` | `boolean` | `false` in the object form | Renders `<name>`; a missing operand is an error |
| `variadic` | `boolean` | `false` | Collects the rest of the operands into an array (`name...`); only the last argument may be variadic |
| `choices` | `string[]` | none | Rejects other values with `Allowed choices are ...` |
| `defaultValue` | `unknown` | none | Value when the operand is omitted |
| `parser` | `(value, previous) => value` | none | Converts the raw string |

### `IOption`

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `flags` | `string` | required | Commander flags: `-p, --port <port>` (value required), `--level [level]` (value optional), `--json` (boolean), `--no-color` (negatable, defaults to `true`) |
| `description` | `string` | none | Help text, translated |
| `required` | `boolean` | `false` | The option must be given; defaults are ignored |
| `defaultValue` | `string \| boolean \| string[]` (object form), `any` (positional form) | none | Value when the option is not given. Not run through `parser` |
| `parser` | `(value, previous) => value` | none | Converts the raw string; also runs on `env` and `preset` values |
| `choices` | `string[]` | none | Rejects other values |
| `env` | `string` | none | Environment variable read when the flag is not on the command line |
| `configKey` | `string` | none | Configuration path used as the default when `defaultValue` is `undefined` |
| `conflicts` | `string \| string[]` | none | Option names (camel case) that must not be combined with this one |
| `implies` | `Record<string, unknown>` | none | Values set on other options when this one is used |
| `preset` | `unknown` | none | Value for an optional-value option given without a value (`--level` alone) |

### Where an option value comes from

| Priority | Source | Goes through `parser` |
| --- | --- | --- |
| 1 | The command line | yes |
| 2 | `env` variable | yes |
| 3 | `implies` of another option that was used | no |
| 4 | `defaultValue`, else the `configKey` value | no |

## Configuration

`@Option({ configKey })` reads any key you name; the package defines no option keys of its own. The value is read once, when `Cli.resolve()` builds the tree.

```ts
// config/app.ts
export default {
  reports: {
    outputDir: '/var/reports',
  },
};

// the command
@Option({ flags: '-o, --out <dir>', configKey: 'reports.outputDir' })
```

## Services and extension points

Arguments and options have no DI services. Two hooks extend them beyond the decorator fields:

| Extension | Where | Use it for |
| --- | --- | --- |
| `parser` | `IArgument.parser`, `IOption.parser` | Converting and validating a value; throw `InvalidArgumentError` for a commander-style error |
| `onCreation(command)` | `CliCommand` | Anything the fields do not cover: `hideHelp()`, variadic options, custom `Option` subclasses. See [Lifecycle hooks](04-lifecycle-hooks.md) |

### Parser: validate and convert a value

```ts sample
import { Argument, CliCommand, Command, InvalidArgumentError, Option } from '@spinajs/cli';

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }
  return n;
}

function isoDate(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new InvalidArgumentError('Expected a date like 2026-10-01.');
  }
  return d;
}

// spinajs invoices:resend 2026-10-01 --batch 0
//   -> error: option '-b, --batch <size>' argument '0' is invalid. Expected a positive integer.
@Command('invoices:resend', 'Resends invoices issued since a date')
@Argument('since', true, 'first issue date', undefined, isoDate)
@Option('-b, --batch <size>', false, 'invoices per batch', 50, positiveInt)
export class ResendInvoicesCommand extends CliCommand {
  public async execute(since: Date, options: { batch: number }): Promise<void> {
    console.log(`Resending invoices since ${since.toISOString()} in batches of ${options.batch}`);
  }
}
```

## Important behaviour

- With `choices` and `parser` on the same argument or option, `choices` checks the raw string and `parser` converts it afterwards, so the choices are strings even when the parser returns numbers.
- `defaultValue` is used as written, never parsed. Give a number default as a number (`50`), not as `'50'`.
- A parser on a variadic argument is called once per value with the accumulated result as `previous`, and its last return value is the argument. Return an array to keep all values.
- A required `@Argument` with a `defaultValue` and no `parser` makes commander throw `a default value for a required argument is never used` while `Cli` builds the tree. That stops every command, not only the faulty one.
- A required option ignores `defaultValue` and `configKey`; `env` still satisfies it.
- Option keys in the options object are camel case of the long flag: `--older-than` is `olderThan`, `--no-color` is `color`.
- `conflicts` and `implies` take those camel-case keys: `conflicts: 'dryRun'`.
- The object form types `defaultValue` as `string | boolean | string[]`; for another type use the positional form.
- The object form types `parser` as `(value: string, previous: any) => unknown`, so any converter such as `(v) => parseInt(v, 10)` fits.

## Best practices

- Prefer `choices` for closed sets: help lists them and invalid values fail before `execute()`.
- Use `configKey` for values that differ per environment (`--env production`), `env` for secrets passed by CI, and `required` only for values with no sensible default.
- Throw `InvalidArgumentError` (re-exported from `@spinajs/cli`) in parsers. Other errors skip commander's formatting and surface as a raw error.

## Patterns and antipatterns

```ts
// Don't: convert in execute() what a parser can convert
@Option({ flags: '--level <n>', choices: ['1', '2', '3'] })
// ...
const level = Number(options.level);

// Do: choices check the raw string, then the parser converts it
@Option({ flags: '--level <n>', choices: ['1', '2', '3'], parser: (v) => parseInt(v, 10) })
```

```ts
// Don't: a string default is never parsed, so `retries` is '3' when the flag is omitted and 3 when it is given
@Option('-r, --retries <n>', false, 'retries', '3', (v) => parseInt(v, 10))

// Do
@Option('-r, --retries <n>', false, 'retries', 3, (v) => parseInt(v, 10))
```

## Examples

### Export orders with a closed set of formats and an env-backed token

```ts sample
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';

interface ExportOptions {
  format: string;
  out: string;
  token?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

// spinajs orders:export 2026-09 2026-10 --format csv
// spinajs orders:export 2026-10 --dry-run            (implies --verbose)
@Command({ nameAndArgs: 'orders:export', description: 'Exports orders of the given months' })
@Argument({ name: 'months', required: true, variadic: true, description: 'months as YYYY-MM' })
@Option({ flags: '-f, --format <format>', description: 'file format', choices: ['csv', 'json', 'xlsx'], defaultValue: 'csv' })
@Option({ flags: '-o, --out <dir>', description: 'output directory', configKey: 'orders.exportDir' })
@Option({ flags: '-t, --token <token>', description: 'storage API token', env: 'ORDERS_EXPORT_TOKEN' })
@Option({ flags: '--dry-run', description: 'only list what would be exported', implies: { verbose: true } })
@Option({ flags: '-v, --verbose', description: 'print every order id' })
export class ExportOrdersCommand extends CliCommand {
  public async execute(months: string[], options: ExportOptions): Promise<void> {
    for (const month of months) {
      console.log(`${options.dryRun ? '[dry run] ' : ''}orders ${month} -> ${options.out}/${month}.${options.format}`);
    }
  }
}
```

### Serve on a port from configuration

```ts sample
import { CliCommand, Command, Option } from '@spinajs/cli';

const toPort = (v: string) => parseInt(v, 10);

// spinajs preview                -> port from `http.port`, host from $PREVIEW_HOST or 127.0.0.1
// spinajs preview --port 8081    -> the command line wins
@Command('preview', 'Serves the built site for a quick check')
@Option({ flags: '-p, --port <port>', description: 'port', configKey: 'http.port', parser: toPort })
@Option({ flags: '-H, --host <host>', description: 'interface to bind', env: 'PREVIEW_HOST', defaultValue: '127.0.0.1' })
export class PreviewCommand extends CliCommand {
  public async execute(options: { port?: number; host: string }): Promise<void> {
    console.log(`Preview on http://${options.host}:${options.port ?? 8080}`);
  }
}
```

### Optional-value, negatable and conflicting flags

```ts sample
import { CliCommand, Command, Option } from '@spinajs/cli';

interface TailOptions {
  json?: boolean;
  pretty?: boolean;
  color: boolean;
  level?: string | boolean;
}

// spinajs logs:tail --level          -> level = 'warn' (preset)
// spinajs logs:tail --level debug    -> level = 'debug'
// spinajs logs:tail --no-color       -> color = false
// spinajs logs:tail --json --pretty  -> error: option '--json' cannot be used with option '--pretty'
@Command('logs:tail', 'Prints new log lines')
@Option({ flags: '--json', description: 'one JSON object per line', conflicts: 'pretty' })
@Option({ flags: '--pretty', description: 'human-readable lines' })
@Option('--no-color', false, 'disable colors')
@Option({ flags: '--level [level]', description: 'minimum level', preset: 'warn', choices: ['debug', 'info', 'warn', 'error'] })
export class TailLogsCommand extends CliCommand {
  public async execute(options: TailOptions): Promise<void> {
    console.log(options);
  }
}
```

## Related

- [Commands](02-commands.md): the `execute()` signature and `@Command`.
- [Lifecycle hooks and commander access](04-lifecycle-hooks.md): raw commander `Option` and `Argument` objects.
- [`Cli` service](07-cli-service.md#translation): how descriptions are translated.
