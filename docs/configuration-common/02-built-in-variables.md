# Built-in variables

The package ships sixteen `ConfigVariable` classes. Each is registered in DI when the package is imported, so every `format()` call can use them without passing anything in.

## How it works

1. Importing `@spinajs/configuration-common` runs `@Injectable(ConfigVariable)` on each class below. That registers the class under the `ConfigVariable` token and under itself, in the root container.
2. `format()` resolves them all with `DI.resolve(Array.ofType(ConfigVariable))` and indexes them by `Name`.
3. For `${name:option}`, `format()` calls `variable.Value(option)`; for `${name}`, `variable.Value(null)`.

## Catalog

Date and time variables use [luxon format tokens](https://moment.github.io/luxon/#/formatting?id=table-of-tokens) as the option.

| Placeholder | Class | Option | Result | Entry |
| --- | --- | --- | --- | --- |
| `${datetime}` | `DateTimeLogVariable` | luxon format, default `dd/MM/yyyy HH:mm:ss.SSS ZZ` | local date and time | both |
| `${date}` | `DateLogVariable` | luxon format, default `dd/MM/yyyy` | local date | both |
| `${time}` | `TimeLogVariable` | luxon format, default `HH:mm:ss.SSS` | local time | both |
| `${utcdatetime}` | `UtcDateTimeLogVariable` | luxon format, default `dd/MM/yyyy HH:mm:ss.SSS ZZ` | UTC date and time | both |
| `${utcdate}` | `UtcDateLogVariable` | luxon format, default `dd/MM/yyyy` | UTC date | both |
| `${utctime}` | `UtcTimeLogVariable` | luxon format, default `HH:mm:ss.SSS` | UTC time | both |
| `${timestamp}` | `TimestampVariable` | `s` for seconds; anything else gives milliseconds | Unix epoch | both |
| `${env:NAME}` | `EnvVariable` | environment variable name | `process.env[NAME]`, or `''` | Node |
| `${path:kind}` | `PathVariable` | `temp`, `home`, `cwd`, `config`, `appdata`, `data`, `cache` | a directory; `''` for any other option | Node |
| `${hostname}` | `HostnameVariable` | none | `os.hostname()` | Node |
| `${user}` | `UserVariable` | none | `os.userInfo().username` | Node |
| `${platform}` | `PlatformVariable` | none | `os.platform()` | Node |
| `${arch}` | `ArchVariable` | none | `os.arch()` | Node |
| `${cwd}` | `CwdVariable` | none | `process.cwd()` | Node |
| `${pid}` | `PidVariable` | none | `process.pid` | Node |
| `${uuid}` | `UuidVariable` | none | `crypto.randomUUID()`, new on every placeholder | Node |

"Node" variables are missing from the browser entry (`@spinajs/configuration-common/browser`), because they import `os`, `path` and `crypto`. In a browser build, `${env:...}` and `${path:...}` expand to `''`.

### `${path:kind}` per platform

| Option | Windows | macOS | Linux and others |
| --- | --- | --- | --- |
| `temp` | `os.tmpdir()` | `os.tmpdir()` | `os.tmpdir()` |
| `home` | `os.homedir()` | `os.homedir()` | `os.homedir()` |
| `cwd` | `process.cwd()` | `process.cwd()` | `process.cwd()` |
| `config`, `appdata` | `%APPDATA%`, else `~\AppData\Roaming` | `~/Library/Application Support` | `$XDG_CONFIG_HOME`, else `~/.config` |
| `data` | `%LOCALAPPDATA%`, else `~\AppData\Local` | `~/Library/Application Support` | `$XDG_DATA_HOME`, else `~/.local/share` |
| `cache` | `%LOCALAPPDATA%`, else `~\AppData\Local` | `~/Library/Caches` | `$XDG_CACHE_HOME`, else `~/.cache` |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Each built-in variable | `ConfigVariable` (collected with `Array.ofType`) and its own class, singleton, root container | the classes above | `ElectronPathVariables` (`${electron-path:...}`, `@spinajs/electron`) | override by registering another `ConfigVariable` with the same `Name`; subclass to change defaults; `DI.unregister(Class)` to remove. See [Custom variables](03-custom-variables.md). |

All built-in classes are exported, so you can subclass one (`class IsoDateTime extends DateTimeLogVariable`) or instantiate it directly (`new EnvVariable().Value('PORT')`).

## Important behaviour

- **Values are computed per placeholder.** `${uuid}-${uuid}` gives two different UUIDs; `${timestamp}` twice in one layout can differ by a millisecond.
- **`DateLogVariable` and `TimeLogVariable` take a constructor default.** `new DateLogVariable('yyyy-MM-dd')` uses that format when no option is given; DI creates the registered instances without one, so `${date}` and `${time}` keep the defaults above.
- **Node variables read the live process.** `${env:NAME}` reads `process.env` on each call, not the `process.env` section of the loaded configuration.

## Best practices

- Prefer `${utcdatetime}` in log files that are shipped to a central store; local time with `ZZ` is easier for humans on one machine.
- Use `${path:data}` or `${path:cache}` for per-user files instead of hard-coding `~/.myapp`; it follows each OS convention.
- Use `${timestamp:s}` when the consumer expects Unix seconds (most HTTP and JWT tooling).

## Examples

### Name a rotated log file per host and process

```ts sample
import { format } from '@spinajs/configuration-common';

// "/tmp/app/web-01-4120-2026-10-17.log" on Linux
const file = format({ app: 'app' }, '${path:temp}/${app}/${hostname}-${pid}-${utcdate:yyyy-MM-dd}.log');

console.log(file);
```

### Read a built-in directly, without `format()`

```ts sample
import { PathVariable, EnvVariable, TimestampVariable } from '@spinajs/configuration-common';

const cacheDir = new PathVariable().Value('cache');
const port = Number(new EnvVariable().Value('PORT') || 8080);
const nowSeconds = Number(new TimestampVariable().Value('s'));

console.log(cacheDir, port, nowSeconds);
```

## Related

- [Templating with `format()`](01-templating.md): how placeholders and options are parsed.
- [Custom variables](03-custom-variables.md): add, override or remove a variable.
- [`@spinajs/electron`](../electron/README.md): ships `${electron-path:...}`.
