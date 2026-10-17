# Templating with `format()`

`format(customVars, layout)` replaces `${...}` placeholders in `layout` and returns the string. Log targets use it for their `layout`, and packages use it for configured file paths (log file `path`, SQLite `Filename`). It is synchronous and has no options.

```ts
function format(customVars: ConfVariables | null, layout: string): string;
type ConfVariables = { message?: string } & { [key: string]: unknown };
```

## How it works

1. `format()` checks `customVars.message`. When it is a non-empty string, it formats `message` first, with the same `customVars`, so `message` can carry its own placeholders.
2. `_format()` loads the global variables once per process: on the first call it resolves `DI.resolve(Array.ofType(ConfigVariable))` and stores each by its `Name`. See [Custom variables](03-custom-variables.md).
3. Conditional blocks `${?name}...${/name}` are evaluated against `customVars` only. A block is kept when the value is not `undefined`, `null` or `''`; otherwise the block and everything in it is removed.
4. Every remaining `${name}` and `${name:option}` is replaced, in order of appearance:
   - `name` found in `customVars` with a truthy value: the custom value is used (rules below).
   - otherwise the global variable named `name` is used: `variable.Value(option ?? null)`.
   - otherwise the placeholder becomes `''`.
5. The result is returned. `format()` never throws for unknown names; a throwing `ConfigVariable.Value()` or custom function propagates.

## Placeholder syntax

| Syntax | Meaning |
| --- | --- |
| `${name}` | value of `name` |
| `${name:option}` | value of `name` with `option`; the option runs up to the next `}` and may contain `:` (`${time:HH:mm}`) |
| `${?name}...${/name}` | render the content only when the custom var `name` is set; `name` is `[a-zA-Z0-9_]+` |

A name is any run of characters other than `:` and `}` (`${electron-path:exe}` is valid). Placeholders do not nest.

### Custom variable values

| Value in `customVars` | `${x}` | `${x:opt}` |
| --- | --- | --- |
| string or number | the value, every occurrence; `$&`, `` $` `` and other replacement patterns stay literal | a property of the string: `''` for most options |
| function | `fn(null)` | `fn('opt')` |
| object | `String(obj)` (`[object Object]`) | `obj.opt`, or `obj.opt()` when it is a function; `''` when missing |
| `0`, `false`, `''`, `null`, `undefined` | treated as absent: falls through to the global variable of the same name, else `''` | same |

Custom values win over global variables of the same name, which makes per-call overrides possible (`format({ hostname: 'web-01' }, '${hostname}')`).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Global variables | `ConfigVariable`, singleton in the root container, collected with `Array.ofType` | the [built-in variables](02-built-in-variables.md) | `ElectronPathVariables` (`@spinajs/electron`) | register a `ConfigVariable`, see [Custom variables](03-custom-variables.md) |
| Per-call variables | none: the `customVars` argument | none | functions and objects in `customVars` | pass a function to compute a value per call |

`format()` itself is a plain function, not a DI service. To change how placeholders expand, add or override variables; there is no hook to replace the parser.

## Important behaviour

- **Global variables are cached forever.** The first `format()` call snapshots the registered `ConfigVariable`s into a module-level map. A variable registered later, even after `DI.clearCache()`, is never seen. Import every variable module before the first `format()`.
- **Falsy custom values are treated as absent.** `format({ count: 0 }, '${count}')` returns `''`, and `format({ user: '' }, '${user}')` returns the OS user name. Pass numbers as strings (`String(count)`).
- **Conditional blocks and substitution disagree on falsy values.** `${?flag}` keeps its block for `0` and `false`, but `${flag}` inside it renders `''`.
- **Conditional blocks only read `customVars`.** `${?env}` or `${?hostname}` never render, because globals are not consulted.
- **Function and object values are not escaped.** Unlike string values, a function result or object property that contains `$&` or `` $` `` is interpreted by `String.replace`: `format({ err: { message: 'a$&b' } }, '${err:message}')` returns `a${err:message}b`.
- **`message` is formatted twice.** Its placeholders are expanded before it is inserted, so user input in `message` that contains `${env:SECRET}` is expanded too. Do not put untrusted text in `message`; put it in another key.
- **Options on string values do not work.** `format({ user: 'bob' }, '${user:upper}')` returns `''`.
- **Root container only.** `format()` resolves variables from the global `DI`; a `ConfigVariable` registered in a child container is invisible.

## Best practices

- Name per-call keys distinctly from globals (`logger`, `requestId`) unless you mean to override a global.
- Use `${?error}...${/error}` around everything that reads `error`, so layouts do not print dangling separators.
- Expand configured paths once, at startup (`format(null, cfg.path)`), not on every write, when the value contains no per-call variables.

## Patterns and antipatterns

```ts
// Don't: user-controlled text in `message` is formatted, so "${env:DB_PASSWORD}" leaks the secret
format({ message: req.body.comment }, '${datetime} ${message}');

// Do: keep untrusted text in its own key; only `message` is formatted recursively
format({ message: 'comment received', comment: req.body.comment }, '${datetime} ${message}: ${comment}');
```

```ts
// Don't: a falsy number is treated as absent and renders ''
format({ retries: 0 }, 'retries=${retries}');

// Do
format({ retries: String(0) }, 'retries=${retries}');
```

## Examples

### Render a log line with an optional error block

```ts sample
import { format } from '@spinajs/configuration-common';

const layout = '${datetime} ${level} ${message}${?error} | ${error:name}: ${error:message}${/error}';

// "17/10/2026 10:02:11.123 +02:00 info request served"
const ok = format({ level: 'info', message: 'request served' }, layout);

// "... error request failed | Error: connection refused"
const failed = format({ level: 'error', message: 'request failed', error: new Error('connection refused') }, layout);

console.log(ok, failed);
```

### Compute a value per call with a function

```ts sample
import { format } from '@spinajs/configuration-common';

let sequence = 0;

const vars = {
  // `${seq:6}` pads the counter to six digits
  seq: (width: string | null) => String(++sequence).padStart(Number(width ?? 1), '0'),
  tenant: { id: 'acme', region: () => process.env.REGION ?? 'eu-central-1' },
};

// "invoice-acme-eu-central-1-000001.pdf"
const fileName = format(vars, 'invoice-${tenant:id}-${tenant:region}-${seq:6}.pdf');

console.log(fileName);
```

### Expand a configured file path

```ts sample
import { format } from '@spinajs/configuration-common';

const configured = '${path:data}/my-app/${env:APP_ENV}/db.sqlite';

// "/home/alice/.local/share/my-app/dev/db.sqlite" on Linux with APP_ENV=dev
const filename = format({}, configured);

console.log(filename);
```

## Related

- [Built-in variables](02-built-in-variables.md): the names `format()` resolves when `customVars` has no match.
- [Custom variables](03-custom-variables.md): add or override a global `${...}` variable.
- [`@spinajs/log`](../log/README.md): target `layout` and file `path` options are expanded with `format()`.
