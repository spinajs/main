# Manifest diff and CI

`spinajs manifest:diff <base> <head>` compares two application manifests and says which differences can break a client of the API. The manifest is the contract of the app: routes, request and response schemas, permissions, socket commands, configuration schemas and migrations. Diffing two builds of it is a review aid for a pull request, and a gate if you want one.

It does **not** run the app, compare source code or look at behaviour. It sees only what `spinajs build` recorded.

## Usage

```sh
spinajs build --out base.manifest.json      # on the base commit
spinajs build --out head.manifest.json      # on the head commit
spinajs manifest:diff base.manifest.json head.manifest.json --fail-on breaking --out diff.md
```

| Argument or option | Default | Meaning |
| --- | --- | --- |
| `<base>`, `<head>` | required | Manifest files. Each is read and validated; a file that fails validation, or whose `manifestVersion` is not the supported one (2), makes the command throw |
| `--format <format>` | `markdown` | `markdown` renders the report below; `json` prints the diff object |
| `--fail-on <level>` | none | `breaking`: exit code 1 when the diff holds a breaking change. Without it the exit code is `0` whatever the diff holds |
| `-o, --out <path>` | stdout | Write the report to a file. The bin also logs to stdout, so a script that reads the report should always use `--out` |

Both manifests are cut down to what the runtime loads before they are compared (the same cut `generate:openapi` and `generate:client` make): an entry with `mountedBy` is left out. A route that only a registration serves, and that you move out of the scanned directories, therefore shows as a removed route. See [The app's own classes](README.md#the-apps-own-classes).

## Output

A report starts with a verdict, then the short hashes of the two manifests, then one table per section that has changes.

```md
## Manifest diff

Result: **BREAKING** (5 breaking of 6 changes)

`47f752161232` -> `ffffffffffff`

### routes

| Change | Id | Breaking | Detail |
| --- | --- | --- | --- |
| changed | `GET /users/:id` | yes | response.name property removed |
| changed | `GET /users/list` | yes | parameter query (FromQuery) removed; response[].name property removed |
| changed | `POST /users/create` | yes | response\|UserDto.name property removed |

### permissions

| Change | Id | Breaking | Detail |
| --- | --- | --- | --- |
| changed | `GET /health/get` | yes | health:read now required on GET /health/get |

### schemas

| Change | Id | Breaking | Detail |
| --- | --- | --- | --- |
| changed | `spinajs/app-basic/UserDto` | no | schema changed |

### config

| Change | Id | Breaking | Detail |
| --- | --- | --- | --- |
| removed | `app` | yes |  |
```

This is the snapshot `packages/manifest/test/__snapshots__/breaking.md`, rendered from the `app-basic` fixture and an edited copy of it.

The verdict line is one of `no changes`, `non-breaking (<n> changes)` or `**BREAKING** (<b> breaking of <n> changes)`. The sections appear in this order, and only when they have changes: `routes`, `permissions`, `schemas`, `config`, `migrations`, `services`, `commands`, `socket`. Rows are sorted by id, then by change kind, by code unit, so two runs over the same pair of manifests give the same text. A `|` in a detail is escaped.

`--format json` prints `{ "base": "<hash>", "head": "<hash>", "changes": [...], "breaking": <boolean> }` with two-space indentation. A change is `{ "section", "kind", "id", "breaking", "detail"? }`; `kind` is `added`, `removed` or `changed`.

The hashes are each manifest's `hash` field, the value `hashManifest` computes and `spinajs build` prints. Once the pull request is deployed, `GET /telemetry/health` reports the hash of the manifest the app booted from in `manifest.hash`: it starts with the 12 characters after `->`, or equals `head` in JSON, when production runs what was reviewed. See [Check what runs](deploying.md#check-what-runs).

## What is breaking

A change is breaking when a client written against the base can fail against the head. The direction matters: a request is what the client sends, a response is what it reads.

### Routes

A route is identified by its method and full path (`GET /users/:id`). Renaming a handler that has no path of its own moves its URL, so it counts as a removal plus an addition.

| Change | Breaking |
| --- | --- |
| Route removed | yes |
| Route added | no |
| Parameter removed | yes |
| Optional parameter became required | yes |
| Required parameter added | yes |
| Optional parameter added | no |
| Handler or controller class renamed under the same method and path | no |
| Parameter or response type changed | see the schema rules below |

A rename under the same `METHOD fullPath` is a `changed` entry with the detail `client method users.get renamed to users.read: generated hooks and query keys change`. HTTP callers are unaffected, but a client generated with `generate:client` names its methods, hooks and query keys after the controller (class name without `Controller`, first letter lowered) and the handler, so the finding tells a reviewer the frontend must follow. A handler without a path of its own is not covered: its URL moves with the name, so it stays a removal plus an addition.

A parameter is identified by where it travels (query key, header, whole body), so renaming the argument in code while the wire name stays the same is not a change. Arguments the framework injects (the request, the response, DI values, models loaded with `@FromModel`) are not request parameters and are ignored.

### Schema directions

Types are compared structurally through the schemas the build derived, following `$ref`, `allOf`, unions and recursive types.

| Change | In a request (client sends) | In a response (client reads) |
| --- | --- | --- |
| Property added | no | no |
| Property removed | no | yes |
| Property became required | yes | no |
| Property stopped being required | no | yes |
| Enum value removed | yes | no |
| Enum value added | no | yes |
| Union member removed | yes | no |
| Union member added | no | yes |
| Type narrowed | yes | no |
| Type widened | no | yes |
| `nullable` removed | yes | no |
| `nullable` added | no | yes |
| `additionalProperties` set to `false` | yes | no |
| `additionalProperties` no longer `false` | no | yes |
| Type changed to an incompatible one | yes | yes |
| `$ref` of the head no longer resolves | yes | yes |

`integer` counts as a subset of `number`. A type with no schema, only text, is breaking when the text changes. Reordering union members, and the different ways to write a nullable type, are not changes.

### Permissions

The `permissions` section compares what each route requires: its `@Access` permissions, those of its controller, and its policies.

| Change | Breaking |
| --- | --- |
| A requirement added to a route that required nothing | yes |
| A requirement added to a route that already had one | no |
| A requirement removed | no |

A route that is served only by a registration (an entry with `mountedBy`) is compared too, as a non-breaking change marked "the route is served only if a registration runs".

### Other sections

| Section | Breaking | Notes |
| --- | --- | --- |
| `config` | A configuration module removed | A changed configuration schema is `config schema changed`, non-breaking |
| `migrations` | A migration removed | A changed connection, environment or file is non-breaking |
| `schemas` | never | Informational. A schema that changed shows as `schema changed`; the route or socket entry that uses it carries the verdict |
| `services` | never | Registration, lifetime or `async` changed |
| `commands` | never | CLI command options or arguments changed |
| `socket` | never | A command or event added, removed, or with a changed payload or result schema |

Socket changes are reported, not classified. Review them by hand.

## Exit codes

| Situation | Exit code |
| --- | --- |
| No `--fail-on`, or no breaking change | `0` |
| `--fail-on breaking` and the diff is breaking | `1`, the report is written |
| A manifest cannot be read, or the report cannot be written | The command throws; the bin logs the message and exits with `-1`, and no report is written |

A CI step that has to tell "breaking" from "failed" checks both the code and the report file, as the workflow below does.

## Known limits

- The diff compares manifests, so it is only as exact as the derived types. A type the build emits as `{}` (`any`, a function) hides every change to it; the `SCH001` and `SCH002` warnings of `spinajs build` report those.
- `buildEnv` is part of the manifest hash. Build both sides under the same `APP_ENV`, or the hashes differ for that reason alone.

## The PR comment workflow

`.github/workflows/manifest-diff.yml` runs on pull requests to the `v4` branch. It builds the manifest of the base and of the head of the monorepo's reference application (`packages/http-socket-example`), diffs them, and keeps one comment on the pull request up to date.

| Job | Permissions | Does |
| --- | --- | --- |
| `diff` | `contents: read` | Checks out base and head, builds both, runs `manifest:diff ... --fail-on breaking --out diff.md`, writes the report to the job summary and uploads `comment.md` as an artifact |
| `comment` | `pull-requests: write` | Checks out nothing. Downloads the artifact and creates the comment, or updates the one that holds the marker `<!-- spinajs-manifest-diff -->` |

Points worth copying:

- **Code from the pull request runs only in the read-only job.** The job that holds the write token never builds or runs it.
- **Fork pull requests** get a read-only token, so the `comment` job is skipped for them (`head.repo.full_name == github.repository`). The report is in the job summary either way.
- **The same compiler analyses both sides.** The base is compiled with `tsc -b`, its fragments are regenerated with the head `scripts/build-fragments.mjs`, and the head CLI builds both manifests, because the base may predate `spinajs build`. The CLI runs from the head app: run from the base it would load the base packages next to its own, and two copies of `@spinajs/di` in one process.
- **Breaking is a signal, not a block.** The job step exits `0` when the diff is clean, treats exit code 1 with a non-empty report as "breaking" (a warning annotation, then a failing step), and fails the job with `manifest:diff failed with exit code <n>` for any other result. The workflow is not a required check.

### Adopting it in your app

The workflow is written for this monorepo: it builds the packages from source and has to analyse an old base. An app that consumes `@spinajs/*` from npm needs less. This recipe is the same flow reduced to what an app does; it follows the steps above and has not been run as written:

```yaml
name: manifest-diff
on:
  pull_request:

permissions:
  contents: read

jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { path: head }
      - uses: actions/checkout@v4
        with: { ref: "${{ github.event.pull_request.base.sha }}", path: base }
      - uses: actions/setup-node@v4
        with: { node-version: 22.x }
      - name: build both sides
        run: |
          for side in base head; do
            (cd "$side" && npm ci && npm run build && npx spinajs build --out "$GITHUB_WORKSPACE/$side.manifest.json")
          done
      - name: diff
        run: cd head && npx spinajs manifest:diff "$GITHUB_WORKSPACE/base.manifest.json" "$GITHUB_WORKSPACE/head.manifest.json" --fail-on breaking --out "$GITHUB_WORKSPACE/diff.md"
      - run: cat diff.md >> "$GITHUB_STEP_SUMMARY"
        if: always()   # diff.md exists only when the diff step ran to the end
```

Things to settle for your repository:

- Build with the `APP_ENV`, `--app`, `--apppath` and `--config-path` of your deployment on both sides, from the folder the app runs from ([Deploying](deploying.md#build-the-image)).
- The base must be a version that has the `build` command. Before that, build both manifests with the head CLI, as the monorepo workflow does.
- To post the report as a comment, add a second job like `comment` above rather than giving the build job a write token.

## A CI recipe

One pipeline that builds, checks the wiring and fails when committed generated files are stale:

```yaml
- run: npm ci
- run: npm run build                                       # compile the app: spinajs build reads lib/, not src/
- run: npx spinajs build --fail-on-warning                 # manifest, with the deployment's APP_ENV
- run: npx spinajs doctor --format github                  # annotations on the pull request
- run: npx spinajs generate:client --out src/generated/client.ts
- run: npx spinajs generate:config-types
- run: npx spinajs generate:openapi --out openapi.json
- run: git diff --exit-code src/generated/client.ts src/spinajs-config.d.ts openapi.json   # generator drift
- run: npx tsc --noEmit
```

| Step | Fails when |
| --- | --- |
| `spinajs build --fail-on-warning` | The analyzer reports an error, or any warning (`CMP006`, `CMP008`, `CLI001`, ...); `CMP007` always fails it |
| `spinajs doctor --format github` | A diagnostic of severity `error` exists (`--fail-on warning` includes warnings). The `github` format prints `::error file=...,line=...::...` lines that GitHub shows on the changed files |
| `git diff --exit-code` | A committed generated file differs from what the current manifest produces. A generated file that was never committed is not caught: add `git status --porcelain` on the output paths for that |

Notes on the drift check:

- Commit only what people read or import (the client, the config declarations, perhaps `openapi.json`). The manifest is a build product: rebuild it in CI, do not commit it.
- The generators write the same text for the same manifest. The manifest hash that the OpenAPI and AsyncAPI documents carry (`info.x-spinajs-manifest-hash`) leaves out `app.root` and `generatedAt`, so a different checkout path does not change it. It does cover `buildEnv`, so build under one `APP_ENV` everywhere.
- Pass the same generator options locally and in CI (`--title`, `--server-url`, `--route-prefix`), or the committed file differs.
- `generate:openapi` reads `http.controllers.route.prefix` from the configuration unless `--route-prefix` is given, so it needs the configuration the app runs with. Pass `--route-prefix` explicitly to make the result independent of the environment.

## Related

- [Command reference](../cli/08-command-reference.md): every option of `build`, `doctor`, `manifest:diff` and the generators.
- [spinajs doctor](../compiler/doctor.md): the rules and formats behind the `doctor` step.
- [Deploying a manifest-built app](deploying.md): the image build and the environment variables.
- [What is new in 4.x](../whats-new-4.0.md#ci): the short form of the CI recipe.
