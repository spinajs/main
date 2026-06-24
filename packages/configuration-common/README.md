# `@spinajs/configuration-common`

Shared **contracts and templating engine** for SpinaJS configuration. It defines
the abstract `Configuration` / `ConfigurationSource` / `ConfigVarProtocol` types
that concrete modules (`@spinajs/configuration`, the FS/HTTP/AWS sources, ...)
implement, plus a small string-templating helper, `format()`, used across the
framework (logging, file paths, messages) to expand `${...}` variables.

This package has no runtime dependency beyond `@spinajs/di`.

## Installation

```bash
npm install @spinajs/configuration-common
```

## Templating: `format()`

```ts
import { format } from '@spinajs/configuration-common';

format(customVars: ConfVariables | null, layout: string): string
```

`format()` replaces placeholders in `layout`. A placeholder is `${name}` or
`${name:option}`:

- `name` is looked up first in `customVars`, then in the DI-registered built-in
  variables. An unknown name expands to an empty string.
- `option` (the part after `:`) is variable-specific — for built-ins it is the
  format/argument (e.g. a luxon format), for an object custom var it is a
  property lookup (`${error:message}`).

```ts
format({ message: 'logged in', user: 'alice' }, '${date} [${user}] ${message}');
// "24/06/2026 [alice] logged in"
```

See [examples/01-format-basics.ts](examples/01-format-basics.ts).

### Custom variable values

`customVars` entries may be:

| Value kind | Placeholder | Behaviour |
| --- | --- | --- |
| string / number | `${x}` | inserted as-is (special replacement patterns like `$&` are kept literal) |
| function | `${x:arg}` | called with `arg` (or `null`); the return value is inserted |
| object | `${x:prop}` | reads `obj.prop`; if that property is itself a function it is called |

The special `message` field is **formatted recursively** before being
interpolated, so it may contain its own `${...}` placeholders.

### Conditional blocks

`${?var} ... ${/var}` renders the enclosed content only when `var` is truthy
(present, not `null`, not `''`). The condition is evaluated before the inner
variables are substituted.

```ts
format(
  { message: 'failed', error: { message: 'timeout' } },
  '${message}${?error} | error: ${error:message}${/error}',
);
// "failed | error: timeout"   (and just "failed" when error is absent)
```

See [examples/03-conditional-blocks.ts](examples/03-conditional-blocks.ts).

## Built-in variables

All are registered in DI via `@Injectable(ConfigVariable)` and available to
every `format()` call (and in configuration files). Full catalog in
[examples/02-builtin-variables.ts](examples/02-builtin-variables.ts).

| Variable | `:option` | Result |
| --- | --- | --- |
| `${datetime}` | luxon format | local date+time (default `dd/MM/yyyy HH:mm:ss.SSS ZZ`) |
| `${date}` | luxon format | local date (default `dd/MM/yyyy`) |
| `${time}` | luxon format | local time (default `HH:mm:ss.SSS`) |
| `${utcdatetime}` / `${utcdate}` / `${utctime}` | luxon format | same, in UTC |
| `${timestamp}` | `s` | Unix epoch in ms, or seconds with `:s` |
| `${env:NAME}` | env var name | `process.env[NAME]` (or `''`) |
| `${path:opt}` | `temp` `home` `cwd` `config` `data` `cache` `appdata` | resolved directory (cross-platform); `appdata` is an alias of `config` |
| `${hostname}` | — | `os.hostname()` |
| `${user}` | — | current OS username |
| `${platform}` / `${arch}` | — | `os.platform()` / `os.arch()` |
| `${cwd}` | — | `process.cwd()` |
| `${pid}` | — | current process id |
| `${uuid}` | — | a fresh random UUID per call |

### Defining your own variable

```ts
import { Injectable } from '@spinajs/di';
import { ConfigVariable } from '@spinajs/configuration-common';

@Injectable(ConfigVariable)
export class AppNameVariable extends ConfigVariable {
  public get Name() { return 'appname'; }
  public Value(option?: string) { return option === 'upper' ? 'MYAPP' : 'myapp'; }
}
// now usable anywhere as ${appname} / ${appname:upper}
```

See [examples/04-custom-variable.ts](examples/04-custom-variable.ts).

## Registering with the DI container (required)

This is the part you **must** get right: a `ConfigVariable` or a
`ConfigVarProtocol` only works after it has been registered in the SpinaJS DI
container. Nothing scans your code for subclasses — registration is explicit and
happens through the `@Injectable(...)` decorator.

### How `@Injectable(Base)` registers a class

`@Injectable` from `@spinajs/di` does two things (see its implementation):

```ts
export function Injectable(as?: Class<unknown> | string) {
  return (target) => {
    if (as) DI.register(target).as(as); // register under the BASE type (the token)
    DI.register(target).asSelf();        // and under its own type
  };
}
```

The argument is the **token** other code resolves against. For this package the
token is the abstract base class:

- variables → `@Injectable(ConfigVariable)`
- protocols → `@Injectable(ConfigVarProtocol)`

Registering *under the base type* is what makes the collection lookup work.
`format()` does not know your class by name — on its first call it resolves
**every** class registered under `ConfigVariable` at once and caches them:

```ts
// inside format()
DI.resolve(Array.ofType(ConfigVariable)).forEach((v) => Vars.set(v.Name, v));
```

`Array.ofType(ConfigVariable)` is a typed array token meaning "all
implementations of `ConfigVariable`". So if you write
`@Injectable()` with **no argument** (or `@Injectable(SomethingElse)`), the class
is registered only as itself, never collected, and `${yourvar}` silently expands
to `''`. Always pass the base type.

```ts
@Injectable(ConfigVariable)        // ✅ collected by format()
@Injectable()                      // ❌ registered, but not under ConfigVariable
```

### The file has to be loaded

The decorator runs **as a side effect of the module being imported** — that line
is where `DI.register(...)` actually executes. A class in a file that is never
imported is never registered. Two ways this happens:

1. **In a SpinaJS app (the normal case):** the framework loads your modules from
   the directories configured under the relevant `system.dirs.*` keys, which
   runs the decorators for you. You usually do not call `DI.register` by hand.
2. **Standalone / tests:** you must import the file yourself so the decorator
   runs before the first `format()` (for variables) or before the configuration
   module resolves protocols.

```ts
import './variables/app-name.js'; // side-effect import: runs @Injectable, registers the var
import { format } from '@spinajs/configuration-common';

format(null, '${appname}'); // now resolves
```

> Ordering note: `format()` caches the variable set on its **first** call. Make
> sure every custom `ConfigVariable` module is loaded before that first call, or
> it won't be picked up for the lifetime of the process.

### Protocols are registered the same way

A `ConfigVarProtocol` (for values like `aws-secret://db/password`) is resolved by
the concrete `@spinajs/configuration` module, which looks up all classes
registered under `ConfigVarProtocol`. Register it identically:

```ts
@Injectable(ConfigVarProtocol)
export class EnvProtocol extends ConfigVarProtocol {
  public get Protocol() { return 'env://'; }
  public async getVar(path: string, configuration: any) { /* ... */ }
}
```

Because `ConfigVarProtocol` extends `AsyncService`, the configuration module
resolves and initializes it asynchronously at load time. See
[examples/05-config-var-protocol.ts](examples/05-config-var-protocol.ts).

## Configuration contracts

These abstract classes are implemented by concrete configuration modules; you
typically consume them by type:

- **`Configuration`** — the runtime config service: `get(path, default)`,
  `set`, `merge`, `mergeSource`, `load`, plus `RootConfig` / `RunApp` /
  `AppBaseDir`.
- **`ConfigurationSource`** — an ordered loader (`Order`, `Load`) for a config
  origin (JSON files, env, database, ...).
- **`ConfigVarProtocol`** + **`ConfigVar`** — resolve protocol-prefixed values
  such as `aws-secret://db/password`; `ConfigVar` is a lazy, memoized holder for
  values that can only be computed after all modules are resolved.

See [examples/05-config-var-protocol.ts](examples/05-config-var-protocol.ts).

## Examples

Runnable examples live in [examples/](examples/) — start with its
[README](examples/README.md).

## API docs

```bash
npm run build-docs   # typedoc -> docs/
```
