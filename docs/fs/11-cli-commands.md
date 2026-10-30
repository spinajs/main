# CLI commands

The package ships `spinajs fs-*` commands that run any provider operation from a terminal: list, read, write, copy, move, hash, zip. They use your application's `fs` configuration, so `fs-ls uploads` lists the same `uploads` provider your code uses.

## How it works

1. The package config adds its compiled `cli` directory to `system.dirs.cli`. `@spinajs/cli` discovers the commands there.
2. You run `spinajs <command> <fs> ...`; the first argument is a provider name.
3. The `spinajs` binary runs every `Bootstrapper`, `FsBootstrapper` included, and boots the configuration.
4. Each command calls `ensureProviders()`: it resolves `fsService` when the `'__file_provider_instance__'` map does not exist yet.
5. The command calls the matching helper or provider method, eg. `fs-cp` calls `_copy(src, dst, fs, dstFs)`.
6. Results go to the `fs` logger. Errors are logged with `Log.error` and **not** rethrown; the command sets `process.exitCode` to `1`.

## Commands

| Command | Arguments | Options | Does |
| --- | --- | --- | --- |
| `fs-describe` | | | Lists every provider and its class. |
| `fs-ls` | `<fs> [path]` | | Lists a directory; `path` defaults to `/`. |
| `fs-stat` | `<fs> <path>` | | Prints type, size and the three dates. |
| `fs-cat` | `<fs> <path>` | `-e, --encoding <encoding>` (default `utf-8`) | Prints a file. |
| `fs-exists` | `<fs> <path>` | | Prints whether the path exists. |
| `fs-hash` | `<fs> <path>` | `-a, --algo <algo>` | Prints the file digest. |
| `fs-info` | `<fs> <path>` | | Prints `metadata()` as JSON. |
| `fs-mkdir` | `<fs> <path>` | | Creates a directory with its parents. |
| `fs-write` | `<fs> <path>` | `-c, --content <content>`, `-f, --from-file <fromFile>`, `-e, --encoding <encoding>` (default `utf-8`) | Writes inline text, or a local file's bytes. One of `-c` or `-f` is required. |
| `fs-rm` | `<fs> <path>` | | Deletes a file or directory. |
| `fs-cp` | `<fs> <src> <dst>` | `-d, --dst-fs <dstFs>` | Copies, to another provider with `-d`. |
| `fs-mv` | `<fs> <src> <dst>` | `-d, --dst-fs <dstFs>` | Moves, to another provider with `-d`. |
| `fs-upload` | `<fs> <src> [dst]` | | Uploads a local file; `dst` defaults to its base name. |
| `fs-download` | `<fs> <path>` | | Prints a local path to the file. |
| `fs-zip` | `<fs> <paths>` | `-o, --out <out>`, `-d, --dst-fs <dstFs>` | Zips comma-separated paths. Without `-d` the archive goes to `fs-temp` (for `fsNative` sources). |
| `fs-unzip` | `<fs> <src> [dst]` | `-d, --dst-fs <dstFs>` | Extracts an archive, into another provider with `-d`. |

```sh
spinajs fs-describe
spinajs fs-ls uploads incoming
spinajs fs-write documents notes/today.txt --content "release at 15:00"
spinajs fs-cp documents invoices/2024 invoices/2024 --dst-fs archive
spinajs fs-zip documents "invoices,contracts" --out backup.zip --dst-fs archive
spinajs fs-hash uploads incoming/video.mp4 --algo sha512
```

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `system.dirs.cli` | `string[]` | includes `node_modules/@spinajs/fs/lib/cli` under `WORKSPACE_ROOT_PATH` (or `cwd`) and one directory up | directory paths | Where `@spinajs/cli` finds commands. Set `WORKSPACE_ROOT_PATH` when you run `spinajs` from another directory. |

Provider configuration is the same as for the application: see [Providers and configuration](01-providers-and-configuration.md#configuration).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `fs-*` commands | `@Command(...)` classes extending `CliCommand` from `@spinajs/cli` | the 16 commands above | none | Write your own command in a directory listed in `system.dirs.cli`. `ensureProviders()` is not exported: resolve `fsService` yourself. |

### Custom command: disk usage of a directory

```ts sample
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { fs, fsService, getFs } from '@spinajs/fs';

@Command('fs-du', 'Prints the total size of a directory in a filesystem')
@Argument('fs', true, 'Name of filesystem to use')
@Argument('path', false, 'Directory to measure ( defaults to fs root )')
export class FsDuCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(fsName: string, path?: string): Promise<void> {
    await DI.resolve(fsService);

    try {
      const total = await this.size(getFs(fsName), path ?? '/');
      this.Log.info(`${path ?? '/'} ( fs: ${fsName} ): ${total} bytes`);
    } catch (err) {
      this.Log.error({ error: err, fsName }, 'Cannot measure ${fsName}');
      process.exitCode = 1;
    }
  }

  protected async size(provider: fs, dir: string): Promise<number> {
    let total = 0;
    for (const name of await provider.list(dir)) {
      const child = dir === '/' ? name : `${dir}/${name}`;
      const info = await provider.stat(child);
      total += info.IsDirectory ? await this.size(provider, child) : info.Size ?? 0;
    }
    return total;
  }
}
```

Compile it into a directory you add to `system.dirs.cli`, then run `spinajs fs-du uploads incoming`.

## Important behaviour

- A failing command logs the error, sets `process.exitCode` to `1` and returns normally, so `spinajs` exits with code `1`. A custom command can set `process.exitCode` the same way.
- `fs-hash` without `--algo` labels the digest with `fs.hasher.defaultAlgorithm`, or `sha256` when it is not set.
- `fs-write --from-file` writes the bytes unchanged; `--encoding` applies to `--content` only.
- `fs-download` on a local provider prints the existing path and copies nothing.
- The commands call the providers, so registered [middlewares](07-middlewares.md) (eg. `AuthzFsMiddleware`) apply to them.

## Best practices

- Run `fs-describe` first on a new environment to check that every provider booted.
- Use `fs-cp --dst-fs` and `fs-zip --dst-fs` for ad-hoc backups between providers instead of shell copies, so `basePath` sandboxing applies.

## Related

- [File operations](02-file-operations.md): what each command calls.
- [Providers and configuration](01-providers-and-configuration.md): the providers the commands see.
