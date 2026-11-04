# Command reference

Every command the `spinajs` bin ships, with its options. Commands from other packages (`@spinajs/orm-cli`, `@spinajs/http`) are discovered through `system.dirs.cli`, so they exist only when that package is installed ([Command discovery](05-command-discovery.md)).

## Framework options

These work with every command. `@spinajs/configuration` consumes them and the argv provider strips them before commander parses ([Running the CLI](01-running-the-cli.md#framework-options)).

| Option | Meaning |
| --- | --- |
| `--app <name>` | Application whose config is loaded |
| `--env <name>` | Environment |
| `--apppath <path>` | Applications base directory |
| `--config-path <path>` | One extra config folder |
| `--help`, `--version` | Help, and the installed `@spinajs/cli` version |

## Commands of `@spinajs/cli`

| Command | Needs | What it does |
| --- | --- | --- |
| `build` | `@spinajs/compiler` | Analyzes the app and writes `app.manifest.json` |
| `doctor` | `@spinajs/compiler` | Checks the manifest for wiring, routing and configuration problems |
| `upgrade` | `@spinajs/codemods` | Applies the codemods of a major version |
| `manifest:diff <base> <head>` | none | Compares two manifests and classifies breaking changes |
| `generate:openapi` | `@spinajs/openapi` | Writes an OpenAPI 3.1 document from a manifest |
| `generate:asyncapi` | `@spinajs/asyncapi` | Writes an AsyncAPI 3.0 document from a manifest |
| `generate:client` | `@spinajs/client` | Writes a typed HTTP client and socket contracts |
| `generate:config-types` | `@spinajs/compiler` | Writes the `ConfigPaths` declarations |
| `configuration:dump` | none | Logs the resolved configuration |

The packages in the "Needs" column are optional peers of `@spinajs/cli`. A command whose package is missing fails with `install <package> to use <command>` (`upgrade`: `Install @spinajs/codemods to use upgrade: npm i -D @spinajs/codemods`).

### `build`

```sh
spinajs build [--tsconfig <path>] [-o, --out <path>] [--no-schemas] [--fail-on-warning] [--allow-no-dirs]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--tsconfig <path>` | `tsconfig.json` | Application `tsconfig`; its folder is the app root |
| `-o, --out <path>` | `app.manifest.json` | Manifest to write |
| `--schemas` / `--no-schemas` | `--schemas` | Derive JSON Schemas from types, or skip |
| `--fail-on-warning` | off | Exit 1 on an analyzer warning |
| `--allow-no-dirs` | off | Build an app whose `system.dirs` name none of its folders |

Exit code 1 on an analyzer error, on `CMP007`, on `CLI002` (the written manifest fails its JSON Schema and is removed), and with `--fail-on-warning` on a warning. Full behaviour: [`build`](README.md#build).

### `doctor`

```sh
spinajs doctor [-m, --manifest <path>] [-c, --config] [-f, --format <format>] [--fail-on <severity>]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-m, --manifest <path>` | `app.manifest.json` | Manifest written by `spinajs build` |
| `-c, --config` | off | Also validate `system.dirs` and conditional registrations against the loaded configuration |
| `-f, --format <format>` | `text` | `text`, `json` or `github` (workflow annotations) |
| `--fail-on <severity>` | `error` | `warning` or `error`: the lowest severity that gives exit code 1 |

Output goes to stdout: one line per diagnostic in the `text` and `github` formats, a single JSON line in `json`. A manifest that cannot be read is reported as a diagnostic with code `DOCTOR` and severity `error`, and the exit code is 1. Rules and formats: [spinajs doctor](../compiler/doctor.md).

### `upgrade`

```sh
spinajs upgrade --to 4 [--dry-run]
```

| Option | Meaning |
| --- | --- |
| `--to <major>` | Required. The only supported value is `4`; any other value throws `Unsupported target major` |
| `--dry-run` | List the files that would change, write nothing |

Run it from the package root: it visits the files `tsconfig.json` matches. It logs each changed file, each warning to check by hand (`file:line message`) and each file left untouched because a transform failed; a failed file sets exit code 1. It warns when it found no source files. Steps the codemod cannot do are in [Upgrading to 4.0](../upgrading/4.0.md).

### `manifest:diff`

```sh
spinajs manifest:diff <base> <head> [--format <format>] [--fail-on <level>] [-o, --out <path>]
```

| Argument or option | Default | Meaning |
| --- | --- | --- |
| `<base>`, `<head>` | required | Two manifest files, the earlier and the later |
| `--format <format>` | `markdown` | `markdown` or `json` |
| `--fail-on <level>` | none | `breaking`: exit 1 when the diff holds a breaking change |
| `-o, --out <path>` | stdout | Write the report to this file. Stdout also carries the framework log, so use `--out` whenever a tool reads the report |

Details, classification and the CI workflow: [Manifest diff and CI](../manifest/diff-and-ci.md).

### `generate:openapi`

```sh
spinajs generate:openapi [-m, --manifest <path>] [-o, --out <path>] [--title <title>] [--doc-version <version>] [--server-url <url>] [--base-path <path>] [--route-prefix <prefix>]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-m, --manifest <path>` | `app.manifest.json` | Application manifest |
| `-o, --out <path>` | `openapi.json` | Output file; missing folders are created |
| `--title <title>` | the app name | Document title |
| `--doc-version <version>` | `1.0.0` | Document version (`--version` belongs to the root command) |
| `--server-url <url>` | none | Adds one entry to `servers` |
| `--base-path <path>` | none | Literal path prefix, for example where a proxy mounts the app |
| `--route-prefix <prefix>` | `http.controllers.route.prefix` of the configuration | The route prefix the router applies |

See [`@spinajs/openapi`](../openapi/README.md).

### `generate:asyncapi`

```sh
spinajs generate:asyncapi [-m, --manifest <path>] [-o, --out <path>] [--title <title>] [--doc-version <version>] [--server-url <url>]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-m, --manifest <path>` | `app.manifest.json` | Application manifest |
| `-o, --out <path>` | `asyncapi.json` | Output file |
| `--title <title>` | the app name | Document title |
| `--doc-version <version>` | `1.0.0` | Document version |
| `--server-url <url>` | none | Server URL such as `ws://localhost:4557` |

See [`@spinajs/asyncapi`](../asyncapi/README.md).

### `generate:client`

```sh
spinajs generate:client [-m, --manifest <path>] [-o, --out <path>] [--module <name>] [--no-socket]
  [--hooks <list>] [--zod [--zod-mini] [--zod-replies] [--zod-unsupported <warn|error>]] [--models]
  [--socket-hooks] [--key-prefix <name>] [--server] [--next] [--mocks [--msw]] [--check]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-m, --manifest <path>` | `app.manifest.json` | Application manifest |
| `-o, --out <path>` | `src/generated/client.ts` | Output file; companion files are written next to it, named after it (`client.zod.ts`). Missing folders are created |
| `--module <name>` | `@spinajs/client/runtime` | Import path of the client runtime in the generated file |
| `--no-socket` | sockets included | Omit socket contracts |
| `--hooks <list>` | none | Comma-separated hooks targets: `react-query`, `swr` |
| `--zod` | off | Write zod schemas |
| `--zod-mini` | off | Use `zod/mini`; needs `--zod` |
| `--zod-replies` | off | Also write lenient reply schemas; needs `--zod` |
| `--zod-unsupported <warn\|error>` | `warn` | What to do with a keyword zod cannot express; needs `--zod` |
| `--models` | off | Decode replies and encode requests into app types |
| `--socket-hooks` | off | Add socket hooks to the hooks files; needs `--hooks` |
| `--key-prefix <name>` | `spinajs` | First element of every generated query key |
| `--server` | off | Write the server-safe client |
| `--next` | off | Write the Next.js adapter; implies `--server` |
| `--mocks` | off | Write mock data and a fake client |
| `--msw` | off | Also write MSW handlers; needs `--mocks` |
| `--check` | off | Write nothing. Exit with code 1 and list each generated file that is missing or differs from disk |

All generated files come from one read of the manifest, so they never disagree. A flag whose generator is not part of the installed `@spinajs/client` fails before anything is written, with `<flag> is not available in this version`. Each generator is released separately, in a 4.x minor, so a flag is accepted from the release that carries its generator; `--check` is available now.

`--check` replaces `generate:client` followed by `git diff --exit-code` in CI. Pass the same flags the app uses locally. It compares text with line endings normalised, so a Windows checkout with `autocrlf` is not reported as stale.

See [`@spinajs/client`](../client/README.md).

### `generate:config-types`

```sh
spinajs generate:config-types [-m, --manifest <path>] [-o, --out <path>] [--modules <list>]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-m, --manifest <path>` | `app.manifest.json` | Application manifest |
| `-o, --out <path>` | `src/spinajs-config.d.ts` | Declaration file to write |
| `--modules <list>` | all | Comma separated config modules; a name the manifest lacks is a warning |

See [Generating typed config paths](README.md#generating-typed-config-paths).

### `configuration:dump`

```sh
spinajs configuration:dump [-p, --path <path>]
```

Logs the whole resolved configuration as JSON, or the value at `--path`.

## Commands of other packages

| Command | Package | What it does |
| --- | --- | --- |
| `http:controllers:cache [-r, --rebuild]` | `@spinajs/http` | Generates the controller parameter and documentation cache ahead of time, for example during an image build. Only missing entries by default; `--rebuild` clears the cache directory first. Fails when any controller fails. See [Controller cache and CLI](../http/21-controller-cache-and-cli.md) |
| `migrate-up [-n, --name] [-c, --connection] [-f, --fake]` | `@spinajs/orm-cli` | [Apply pending migrations](../orm-cli/01-applying-migrations.md) |
| `migrate-down [-n, --name] [-c, --connection] [-a, --all] [-f, --fake]` | `@spinajs/orm-cli` | [Roll back](../orm-cli/02-rolling-back-migrations.md) the last batch, or all with `--all` |
| `migrate-status` | `@spinajs/orm-cli` | [Report](../orm-cli/03-migration-status.md) every migration on every connection; exit 1 while one is pending or failed |
| `migrate-resolve -n <name> [--applied] [--rolled-back]` | `@spinajs/orm-cli` | [Record the outcome](../orm-cli/04-resolving-failed-migrations.md) of a failed migration |
| `migrate-create -n <name> [-d, --dir] [-c, --connection] [-e, --env]` | `@spinajs/orm-cli` | [Scaffold](../orm-cli/05-scaffolding-migrations.md) a migration class |

The `@spinajs/orm-cli` commands are described in [`@spinajs/orm-cli`](../orm-cli/README.md).

## Exit codes

| Command | Exit code 1 when |
| --- | --- |
| `build` | An analyzer error, `CMP007`, `CLI002`, or a warning with `--fail-on-warning` |
| `doctor` | A diagnostic reaches `--fail-on` (default `error`) |
| `upgrade` | A transform failed on a file |
| `manifest:diff` | `--fail-on breaking` and the diff holds a breaking change |

A command that throws (a missing optional package, an unreadable manifest in `manifest:diff` or a generator) makes the bin log the message and exit with code `-1` ([Running the CLI](01-running-the-cli.md#exit-codes)). The generators set no exit code of their own.
