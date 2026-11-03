# Deploying a manifest-built app

An app built with `spinajs build` boots from `app.manifest.json` instead of scanning directories. This page is the recipe for shipping it: what the image build does and in which order, which environment variables the runtime reads, how to bundle the app into one file, and what to do when a deploy fails.

It assumes you know what the manifest is and what `off`, `prefer` and `require` mean; see [What is new in 4.x](../whats-new-4.0.md#from-build-to-a-running-app) and [Runtime modes](README.md#runtime-modes). It does **not** cover process management, readiness checks or the database, only the manifest.

## Build the image

The manifest describes the compiled app, and it records the configuration the build saw, so the order of the steps matters.

1. **Install and compile.** `npm ci`, then your TypeScript build. `spinajs build` reads `lib/` for config files and `lib/config` for `system.dirs`; it does not read `src/config`.
2. **Build the manifest with the deployment's settings**, from the folder the app runs from:

   ```sh
   APP_ENV=production spinajs build --tsconfig tsconfig.json --out app.manifest.json \
     --app web --apppath ./apps --config-path ./deploy/config --fail-on-warning
   ```

   The `--app`, `--apppath` and `--config-path` values are the ones the app starts with, and `APP_ENV` (or `--env`) is the environment it runs in. A config file of another environment that adds a `system.dirs` entry counts only when the build ran under that environment ([The app's own classes](README.md#the-apps-own-classes)).
3. **Optionally run `spinajs doctor`** on the manifest: `spinajs doctor --format github` in CI, plain `spinajs doctor` in a Dockerfile.
4. **Optionally pre-build the controller cache** if the image also runs with `system.manifest.mode` `off`: `spinajs http:controllers:cache`. With a manifest in effect the cache is not read for parameter names ([Controller cache and CLI](../http/21-controller-cache-and-cli.md)).
5. **Ship** `lib/`, `app.manifest.json`, `package.json` and a production `node_modules`. In `require` mode the runtime loads neither `typescript` nor the compiler, and `glob` only for a translation or schema dir that exists, a package fragment without `configFiles` or a config dir with glob syntax in its path ([Runtime](README.md#runtime)). Keep `glob` installed: the packages still depend on it.
6. **Start the app with the manifest on:** `SPINAJS_MANIFEST_MODE=require`, or `system.manifest.mode` in a config file of the app.

A Dockerfile that follows these steps (an illustration of the order, not a tested image):

```dockerfile
FROM node:22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV APP_ENV=production
RUN npx spinajs build --fail-on-warning

FROM node:22-slim
WORKDIR /app
ENV APP_ENV=production SPINAJS_MANIFEST_MODE=require
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/lib ./lib
COPY --from=build /app/app.manifest.json ./
CMD ["node", "lib/index.js"]
```

The names `lib/index.js` and the layout are your app's; the point is that `spinajs build` runs after the compile, in the same working directory the app starts from, under the production `APP_ENV`, and the manifest is copied next to `lib/`. `@spinajs/compiler` and `@spinajs/cli` are build-time dependencies: keep them in `devDependencies`, and the second stage installs without them.

The runtime verifies the manifest's hash and refuses a listed file that leaves the app root. A manifest from a different build of the code than the one deployed fails with `ManifestMissing` when a listed class is missing from its module ([Troubleshooting](#troubleshooting)).

## Environment variables

| Variable | Read by | What it does |
| --- | --- | --- |
| `SPINAJS_MANIFEST_MODE` | `ManifestConfigurationSource` | `off`, `prefer` or `require`. Wins over `system.manifest.mode` of the app's config. Any other value fails the boot with a message naming the three |
| `SPINAJS_MANIFEST` | `ManifestConfigurationSource` | Path of the manifest file. Wins over `system.manifest.path`, default `app.manifest.json`. A relative path resolves against the working directory |
| `SPINAJS_MANIFEST_ROOT` | `@spinajs/manifest` runtime | Directory the app runs from when `app.root` (the build machine's path, recorded in the manifest) does not exist on this machine. Wins over `app.root` even when that exists. Without either, the working directory is used |
| `SPINAJS_PACKAGE_ROOTS` | `@spinajs/manifest` runtime | Path of a JSON file mapping a package name to a directory relative to the app root, for an app that ships without `node_modules`. Without it nothing changes. A mapped directory outside the app root is refused |
| `WORKSPACE_ROOT_PATH` | `@spinajs/configuration` and the packages' config files | Root under which `node_modules/@spinajs/<pkg>/lib` is looked up. When it is unset the configuration detects the hoisting root and sets it. With a manifest in `require` mode the package config files come from the manifest, and setting this variable skips the detection too |
| `SPINAJS_MANIFEST_VALIDATE` | `@spinajs/manifest` runtime | `1` or `true` checks the manifest against its JSON Schema at every boot. Without it only a manifest whose hash does not match is checked, because `spinajs build` checked the file it wrote |
| `NODE_COMPILE_CACHE`, `NODE_DISABLE_COMPILE_CACHE` | Node, through the launchers of the `spinajs` bin and the bundle | The dir of Node's compile cache, or `1` to turn it off. An image keeps the saving only when it has a filled cache dir: set `NODE_COMPILE_CACHE` and start the app once while building the image ([Compile cache](../http/README.md#compile-cache)) |
| `APP_ENV` | `@spinajs/configuration` | The environment: which `*.<env>` config files and migrations apply. `spinajs build` records the value it ran under as `buildEnv`; a different running value logs one warning |

`SPINAJS_MANIFEST_MODE` and `SPINAJS_MANIFEST` are read once per configuration load, before any package config file loads; the order of precedence is environment, then the app's own config files, then the defaults ([One switch](README.md#one-switch)).

`SPINAJS_MANIFEST_ROOT` matters for a manifest that was built in one folder and runs in another: a container image where the build stage ran in `/build` and the runtime stage runs in `/app`, a release folder that is swapped by a symlink, or a bundle. Setting it to the deployed app directory is always safe.

## Check what runs

The manifest hash ties a running app to the pull request that was reviewed. The same value shows up in each of these places:

| Where | What it shows |
| --- | --- |
| `spinajs build` | The `hash` row at the end of its summary: the full hash of the manifest it wrote |
| `app.manifest.json` | The `hash` field |
| `spinajs manifest:diff` | In Markdown, the first 12 characters of both hashes (`` `<base>` -> `<head>` ``); in `--format json`, the full `base` and `head` |
| `GET /telemetry/health` (`@spinajs/telemetry`) | `manifest.hash` and `manifest.mode`: the manifest the running app booted from ([Health and readiness](../telemetry/08-health-and-readiness.md#the-manifest-the-app-booted-from)) |
| The boot log | `Manifest <path> loaded ( <mode>, <first 12 characters> )`, at info level |

To check a deployed app against its pull request:

1. Take the hash from the `hash` row of the CI build that made the image. That build is the authoritative source. The pull request's manifest diff is a preview: on `pull_request`, `actions/checkout` builds the merge of the head into the base as it was then (`refs/pull/<n>/merge`), so its head hash matches the image only if the base did not move before the merge.
2. Read the running one: `curl -s https://<host>/telemetry/health | jq -r .manifest.hash`.
3. Compare. The diff's 12 characters are the start of the full hash. A hash that differs from the image build's means the app runs a manifest from another build; one that differs only from the pull request's diff may come from a base that moved. `null` means it booted without a manifest: `off`, or `prefer` with a missing or stale file, which `prefer` falls back from. Run production in `require`, where neither can happen.

The hash leaves out `app.root`, `generatedAt` and `compilerVersion`, so building in another folder or at another time gives the same hash. It covers `buildEnv` and the dirs the build read, so the build that the pull request diffs and the build of the image must run under the same `APP_ENV` and with the same `--app`, `--apppath` and `--config-path`, from the folder the app runs from, or the hashes differ for that reason alone. Use the same compiler version too: the compiler decides the content, although its version is outside the hash. The hash names the manifest, not the compiled code: a `lib/` from another build that still exports every listed class boots with it.

## One-file bundle

An app can run without `node_modules` at all. The reference is `packages/http-socket-example`: `npm run bundle` writes `dist/bundle`, and `node main.mjs` there boots in `require` mode. The script is `packages/http-socket-example/scripts/bundle.mjs`; [Bundle](../http-socket-example/11-bundle.md) lists the output files and [Bundle](README.md#bundle) explains each part.

The recipe, in the order the script does it:

1. **Compile** the app.
2. **Build the manifest** with the compiler API (`buildAppManifest({ tsconfig, appRoot, out, schemaDerivation: true })`) into the bundle directory.
3. **Map the packages.** Write `package-roots.json`: `{ "<package name>": "packages/<package name>" }` for every entry of `manifest.packages`, and create those directories.
4. **Bundle the config files.** Each package's `configFiles` (relative to its `outDir`) are built with esbuild as standalone modules at `packages/<pkg>/<outDir>/config/<file>`. The configuration source imports them by path, so they cannot live inside `app.mjs`. They are separate copies: keep them plain data.
5. **Bundle the entry** into `app.mjs`. One esbuild call with the app, the controllers, socket controllers, schedules and migrations the manifest lists, and every dependency. Commands are left out: they are CLI-only and would pull the compiler in.
6. **Register a module loader.** A value `__module_loader__` with `load(file)` returns the inlined module for a listed file, so the runtime's import-by-path gets the same module instance as the app's own imports. It throws for a file under the bundle root that was neither inlined nor bundled as a config.
7. **Set the environment** at the top of the entry, with `??=` so the host can override: `SPINAJS_MANIFEST_ROOT` (the bundle directory), `SPINAJS_MANIFEST` (`app.manifest.json` beside it), `SPINAJS_PACKAGE_ROOTS` (`package-roots.json` beside it) and `SPINAJS_MANIFEST_MODE=require`.
8. **Write the launcher** `main.mjs`: it turns on Node's compile cache with `@spinajs/util/compile-cache`, imports `app.mjs` and writes the cache once the app listens.

esbuild options the script sets, each for a reason:

| Option | Why |
| --- | --- |
| `bundle: true`, `platform: 'node'`, `format: 'esm'`, `target: 'node22'` | One ESM file for Node 22 |
| `keepNames: true` | DI and reflection key services and manifest entries by class name; minified names would break the lookup |
| `banner` with `createRequire` | Dependencies that call `require` keep working in an ESM bundle |
| A plugin that replaces `typescript` with a stub that throws on use | `@spinajs/http` and `@spinajs/reflection` import it for runtime type discovery, which a manifest makes unnecessary; it is 9 MB. The stub's message tells you to run with `system.manifest.mode=require` |

Run the result with `node main.mjs`, and deploy `main.mjs` together with `app.mjs`. The reference app takes `PORT`, default a free one, and answers `GET /health` with `{"status":"ok"}`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `warning CMP006 - <Class> (<file>) is not loaded from the manifest: ...` at build | A class of the app is outside what discovery would load: no file under the configured `system.dirs.<section>` exports it (controllers, commands) or imports it (schedules, socket controllers, migrations). The entry stays in the manifest with `mountedBy: 'di'` and nothing imports it for you | Move the class under a configured dir, add its folder to `system.dirs`, or leave it when something registers it yourself (the warning stays) |
| `error CMP007 - no system.dirs entry maps to a source folder of this app. Searched ...`, exit 1, no manifest written | The build read a configuration with no dir that maps to the app. Usual causes: `lib/config` is not compiled, the build runs from another folder, or `--app`, `--apppath`, `--config-path` or `--env` differ from the ones the app runs with | Compile first, run from the app's folder with the app's options. Use `--allow-no-dirs` only for an app that really declares no dirs: then nothing loads from the manifest |
| `warning CMP008 - system.dirs.<key> entry <dir> has no source folder behind it` | A configured dir inside the app maps to no source folder, often a dir computed from the wrong working directory | Run the build from the folder the app runs from |
| `warning CLI001 - the working directory ... is not the app root ...` | The working directory of `spinajs build` is not the `tsconfig` folder, and `system.dirs` was computed from it | Run it from the folder the app runs from |
| `error CLI002 - the manifest fails its JSON Schema and was not kept: ...`, exit 1, no manifest written | `spinajs build` checks the manifest it wrote, because the boot skips that check for a manifest whose hash matches | Report it: the compiler wrote a manifest its own schema refuses |
| `ManifestMissing: system.manifest.mode is 'require' but <file> does not exist; run 'spinajs build' first` | `require` and no manifest at that path | Copy the manifest into the image, or set `SPINAJS_MANIFEST` to its real path |
| `ManifestMissing: <file> does not export class <Class> listed in manifest section <section> ...` | The manifest lists a class the deployed file does not have: the manifest and `lib/` come from different builds | Rebuild the manifest after compiling, in the same stage |
| `ManifestMissing: package <name> is a dependency of <app> and listed in the manifest, but is not installed` | The runtime cannot find a package's root: `node_modules` was left out, or `SPINAJS_PACKAGE_ROOTS` does not map it | Install the dependency, or add it to the package roots file |
| `ManifestMissing: SPINAJS_PACKAGE_ROOTS <file> cannot be read` | The variable points at a file that is missing or not JSON | Fix the path; unset it when `node_modules` is present |
| `NoControllerMetadata: <Controller> (<file>) is not in the manifest and system.manifest.mode is 'require': rebuild the manifest ( spinajs build ), or use mode 'prefer'` | A controller exists in the code that the manifest does not list: the manifest is older than the code | Rebuild after the last code change. `prefer` falls back to the TypeScript cache, which needs `typescript` |
| `NoControllerMetadata: The TypeScript controller cache needs the optional peer dependency typescript ...` | `off` mode (or `prefer` with an unlisted controller) in an image without `typescript` | Turn the manifest on, install `typescript`, or run `spinajs http:controllers:cache` during the build |
| Log warning `Manifest was built under APP_ENV '<a>', running under '<b>' ...` | The running `APP_ENV` differs from the build's | Rebuild under the running `APP_ENV`. It is a warning only: promoting a staging image to production is legitimate when the dirs do not differ |
| A socket controller bound to a contract fails the boot in `require` | The manifest was built with `--no-schemas`, so contract payloads have no schemas | Build with schemas (the default) |

## Related

- [Manifest runtime and modes](README.md): the runtime exports, the one switch and package roots.
- [Command reference](../cli/08-command-reference.md#build): every `build` option.
- [spinajs doctor](../compiler/doctor.md): the checks to run before shipping.
- [Manifest diff and CI](diff-and-ci.md): a pipeline that builds, checks and diffs.
- [Bundle](../http-socket-example/11-bundle.md): the reference app's output.
