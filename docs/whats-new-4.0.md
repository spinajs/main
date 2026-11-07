# What is new in 4.x

SpinaJS 4 adds a build step. `spinajs build` reads your TypeScript once, writes what the framework would otherwise discover at boot into `app.manifest.json`, and everything else in this page hangs off that file: validation derived from your types, a typed client, OpenAPI, a linter for the wiring, server-enforced socket contracts and contract tests.

This page is a tour for a 3.x user and a path for a new app. For the list of breaking changes and the codemod, read [Upgrading to 4.0](upgrading/4.0.md). The index of all package docs is [docs/README.md](README.md).

Nothing here is mandatory. With `system.manifest.mode` left at `off` (the default), an app boots as in 3.x apart from the breaking changes in the upgrade guide.

## The tour

### Manifest and compiler

`spinajs build` analyzes the app and the manifest fragments that its `@spinajs/*` dependencies ship, and writes `app.manifest.json`: services and their injected tokens, controllers and routes, models, socket controllers and contracts, schedules, commands, migrations, queue messages, config schemas and usages, and a JSON Schema derived from each type.

```sh
npm run build        # tsc: the build reads lib/config, not src/config
spinajs build        # writes app.manifest.json and prints diagnostics and a summary
```

With a manifest in effect, the boot reads the lists instead of scanning directories and parsing `.d.ts` files, and does not load `typescript`. The compiler never runs your code. See [`@spinajs/compiler`](compiler/README.md), [`spinajs build`](cli/README.md#build) and [`@spinajs/manifest`](manifest/README.md).

### Doctor

`spinajs doctor` reads the manifest and reports wiring mistakes that would otherwise be a 500 at runtime: an injected token nothing registers (`DI001`), a dependency cycle (`DI002`), two routes with the same path (`HTTP001`), a route with no `@Access`, `@Policy`, `@AllowAnonymous` or `@Public` (`HTTP002`), a socket handler that disagrees with its contract (`SOCK001-003`).

```sh
spinajs doctor --format github   # annotations for a GitHub Actions run
```

A route that is open on purpose says why, and doctor stops reporting it:

```ts
@Post('login')
@Public('anyone may try to sign in; the credentials are the guard')
public async login(@Body() body: LoginBody) {}
```

Rules, flags and exit codes: [spinajs doctor](compiler/doctor.md). `@Public`: [Policies](http/13-policies.md).

### Validation from TypeScript types

In `prefer` and `require`, an argument without an explicit schema is validated against the schema derived from its type, so a DTO needs no `@Schema` that repeats its class:

```ts
export class CreateItem {
  public name: string;
  public count: number;
  public tags?: string[];
}

@Post()
public create(@Body() item: CreateItem) {} // { "name": "a", "count": "x" } answers 400
```

Limits that a type cannot say come from JSDoc tags (`@minLength 1`, `@format email`, `@pattern ...`): [DTO constraints with JSDoc tags](validation/09-dto-constraints-jsdoc.md). Precedence, coercion and closed objects: [Validation from the manifest](http/04-route-arguments.md#validation-from-the-manifest). An explicit `@Schema` still wins and may now be a Standard Schema object (for example zod or ArkType): [The `@Schema` decorator](validation/03-schema-decorator.md#standard-schema).

### Generators

Each generator is a `spinajs` command over a pure function of the manifest. The generator packages are optional peers of `@spinajs/cli`: install the one you use.

| Command | Writes | Docs |
| --- | --- | --- |
| `spinajs generate:openapi` | `openapi.json`, OpenAPI 3.1 | [`@spinajs/openapi`](openapi/README.md) |
| `spinajs generate:asyncapi` | `asyncapi.json`, AsyncAPI 3.0 for socket commands and queue messages | [`@spinajs/asyncapi`](asyncapi/README.md) |
| `spinajs generate:client` | `src/generated/client.ts`, typed HTTP client and socket contracts | [`@spinajs/client`](client/README.md) |
| `spinajs generate:config-types` | `src/spinajs-config.d.ts`, the paths `Configuration.get()` and `@Config()` accept | [CLI](cli/README.md#generating-typed-config-paths) |

### Typed client

```ts
import { createAppClient } from './generated/client.js';
import { ProblemError } from '@spinajs/client/runtime';

const client = createAppClient({ baseUrl: 'https://api.example.com' });

try {
  const user = await client.users.get(7); // typed from the controller
} catch (e) {
  if (e instanceof ProblemError) console.error(e.status, e.problem.title);
}
```

The client is plain `fetch`, browser-safe, and throws `ProblemError` for every non-2xx reply. Options, and how to add behaviour to the generated types without editing them: [`@spinajs/client`](client/README.md#options).

### Socket contracts the server enforces

`@SocketController('docs', { contract: DOCS_CONTRACT })` binds a controller to a contract declared with `defineContract<C>('<id>')`. In `prefer` and `require` the server compares the handlers with the contract at startup and validates every incoming payload with Ajv against the contract schema before the handler runs. A bad payload answers `invalid_argument`. In `require` a mismatch fails the boot. The mode matrix is on [Server-enforced contracts](http-socket/02-controllers.md#server-enforced-contracts); the contract type itself is on [Typed contracts](http-socket-common/06-typed-contracts.md).

### Testing

`@spinajs/testing` replaces the per-package test boot copies. `createTestApp` boots an app and puts the DI container back on `dispose()`. With `contractTesting`, every JSON response is checked against the schema derived from the handler's return type, and `dispose()` fails the test on a violation:

```ts
const app = await createTestApp({
  configuration: AppConfiguration,
  contractTesting: { manifest: 'app.manifest.json', mode: 'throw' },
  resolve: [Controllers],
});
```

See [`@spinajs/testing`](testing/README.md), [createTestApp](testing/01-create-test-app.md) and [Contract tests](testing/02-contract-tests.md).

### Errors are `application/problem+json`

HTTP errors follow RFC 9457: `type`, `title`, `status`, `detail`, `instance` and, when present, `code` or `errors`. Other fields of an exception are not copied into the body; declare the ones a client needs in a static `problemFields`. In production an unmapped 500 answers `detail: "Internal server error"`. See [Error handling](http/11-error-handling.md) and the [upgrade note](upgrading/4.0.md#error-bodies-are-applicationproblemjson).

### One middleware contract for routes and the server

Route and server middlewares implement the same optional hooks with one context object: `onBefore(ctx)` (may answer with a `Response`), `onAfter(ctx)` on every framework reply, error replies included, `onFinish(ctx)` once the response finished or the client left, and `onAround(ctx, proceed)`. `http.routes.middlewares` mounts route middlewares on every route of the app. See [Route middlewares](http/14-route-middlewares.md), [Server middlewares](http/15-server-middlewares.md) and the [upgrade note](upgrading/4.0.md#http-middlewares).

### Config arrays replace

An array your app configures replaces the array a package sets, as a scalar does. 3.x concatenated them.

```js
// @spinajs/http-socket ships  http: { socket: { transports: ['websocket', 'polling'] } }
// config/http.js in your app:
export default { http: { socket: { transports: ['websocket'] } } };
// 4.0: ['websocket']   (3.x: ['websocket', 'polling', 'websocket'])
```

Some lists keep concatenating (`system.dirs.*`, `COMPOSED_CONFIG_ARRAYS`). `http.middlewares` is the one to check: a list of your own drops the shipped `helmet` unless you start from `defaultMiddlewares()`. The body and cookie parsers are server middlewares configured in `http.bodyParsers`. The full rules are in the [upgrade guide](upgrading/4.0.md#config-arrays-replace-the-default) and [Configuration](configuration/01-configuration-service.md).

### Decorator metadata is optional

With a manifest, `emitDecoratorMetadata` can be `false`: argument types and `@Autoinject()` types are recorded by the compiler. Keep `experimentalDecorators`. This lets you build with esbuild or `tsx`. See [Building without decorator metadata](manifest/README.md#building-without-decorator-metadata).

### ESM and Node 22

Every package is ESM only with `engines.node >=22.0.0`, and builds into a flat `lib/`. Your app needs `"type": "module"`, `module` and `moduleResolution` set to `node16` or `nodenext`, and `.js` extensions on relative imports. A codemod does the mechanical part:

```sh
npm i -D @spinajs/codemods
npx spinajs upgrade --to 4 --dry-run
```

## From build to a running app

For a new app, after installing the packages you use (`@spinajs/di`, `@spinajs/http` and so on) and `@spinajs/cli` and `@spinajs/compiler` as dev dependencies:

1. **Compile.** `npm run build` (your `tsc`). Output goes where the tsconfig `outDir` says; the manifest records it.
2. **Build the manifest**, from the folder the app runs from, with the `APP_ENV` and the `--app`, `--apppath` and `--config-path` of the deployment: `spinajs build`. Read its diagnostics. A class outside `system.dirs.*` is reported as `CMP006` and is not loaded from the manifest; see [The app's own classes](manifest/README.md#the-apps-own-classes).
3. **Turn the manifest on** with the environment (`SPINAJS_MANIFEST_MODE=require`) or a config file of the app, for example `src/config/system.ts` (compiled to `lib/config/system.js`):

   ```ts
   export default { system: { manifest: { mode: 'require' } } };
   ```

   The environment wins over the config file. `system.manifest.path` defaults to `app.manifest.json` and is relative to the working directory.
4. **Run** the app. Ship `app.manifest.json` with `lib/`. Where the app's directory is not the one the manifest was built in, set `SPINAJS_MANIFEST_ROOT` ([Runtime modes](manifest/README.md#runtime-modes)).

An app that ships without `node_modules` (a single-file bundle) is shown in [Single-file bundle](manifest/README.md#single-file-bundle) and [the example app](http-socket-example/11-bundle.md).

### When to rebuild the manifest

The manifest is a snapshot. A class it does not list is not loaded, and a type it has an old schema for is validated against the old schema. Rebuild after:

- adding, removing or changing a controller, route, route argument type, DTO, model, migration, schedule, socket controller or CLI command;
- installing or upgrading an `@spinajs/*` package (their fragments are merged in);
- changing `system.dirs`, or building for another `APP_ENV` (the manifest records it as `buildEnv`; a different running `APP_ENV` logs one warning in `prefer` and `require`).

In `require`, a controller whose source file the manifest does not list fails registration with `NoControllerMetadata`. In `prefer` and `require`, a class the manifest lists but its module no longer exports fails with `ManifestMissing`. Both mean: rebuild.

### `off`, `prefer` or `require`

| | `off` | `prefer` | `require` |
| --- | --- | --- | --- |
| Manifest read | never | when the file exists | always; a missing file fails the boot with `ManifestMissing` |
| Controllers, migrations, schedules, socket controllers, commands, package config files | directory scans and the `node_modules/@spinajs/*` walk | from the manifest, discovery for what it lacks | from the manifest only |
| Validation from types, coercion of query/path/header values | no | yes | yes |
| Socket contract enforcement | no | yes; what cannot be verified is skipped with a warning (fail-open) | yes; the boot fails on a contract it cannot verify |
| A derived schema that cannot compile | not used | that argument is unchecked, with a warning | the boot fails |
| Build without decorator metadata | arguments stay untyped, with named errors | supported, named errors for what the manifest cannot type | supported, the boot fails for what it cannot type |
| `typescript` needed at runtime | for the controller cache, unless it is prebuilt | no, for controllers the manifest lists | no |

How to pick:

- **`off`** while you adopt the build, or for an app that must keep scanning. Nothing changes at runtime.
- **`prefer`** in development and during migration. A missing manifest falls back to discovery instead of stopping the server. A stale one does not: classes it does not list are not loaded, and a listed class its module no longer exports fails with `ManifestMissing`. It never enforces what it could not verify, so it is not a security boundary.
- **`require`** for production and CI. A stale manifest is an error at boot, not a silent difference between what you tested and what runs. Use it wherever a socket contract or request validation is a correctness or security boundary.

Before you switch on, read [What changes when you switch manifest mode on](manifest/README.md#what-changes-when-you-switch-manifest-mode-on): query values are coerced, derived objects are closed, and undeclared root keys of a whole body are dropped.

## CI

A pipeline that builds, checks the wiring and fails when committed generated files are out of date:

```yaml
- run: npm ci
- run: npm run build
- run: npx spinajs build --fail-on-warning
- run: npx spinajs doctor --format github
- run: npx spinajs generate:client --out src/generated/client.ts
- run: git diff --exit-code src/generated/client.ts   # generator drift
- run: npx tsc --noEmit
```

- `spinajs build` exits 1 on an analyzer error, and with `--fail-on-warning` on a warning too. Run it with the `APP_ENV` and paths of the deployment.
- `spinajs doctor` exits 1 on an error; `--fail-on warning` makes warnings fail too.
- The client generator is deterministic for a given manifest, so a committed `src/generated/client.ts` can be diffed. The manifest itself is a build product: rebuild it in CI.
- [Manifest diff and CI](manifest/diff-and-ci.md) covers `manifest:diff`, the PR comment workflow and a longer recipe; [Deploying a manifest-built app](manifest/deploying.md) covers the image build, the environment variables and the one-file bundle.
## Known limits in 4.0

- **Inherited routes on abstract bases.** A route that a controller inherits from an abstract base class is served at runtime, but the manifest lists such a base under `controllerBases`, and `generate:openapi`, `generate:client` and `manifest:diff` read the `controllers` list only. Those routes are missing from the OpenAPI document, the generated client and the diff until a later 4.x release.
- **Derived validation reads types, not runtime code.** A model from a dependency package derives to an open object, and a nested class whose `@Schema` the compiler cannot evaluate accepts anything. See [Validation from the manifest](http/04-route-arguments.md#validation-from-the-manifest).
- **`await import()` is not followed.** A class only such a call loads gets a `CMP006` warning, although it still runs.
- **Cold start.** This page makes no promise about boot time.

## Reference

| Topic | Page |
| --- | --- |
| Breaking changes, codemod | [Upgrading to 4.0](upgrading/4.0.md) |
| Manifest, modes, runtime | [`@spinajs/manifest`](manifest/README.md) |
| Analyzer, diagnostics | [`@spinajs/compiler`](compiler/README.md), [spinajs doctor](compiler/doctor.md) |
| CLI commands | [`@spinajs/cli`](cli/README.md), [command reference](cli/08-command-reference.md) |
| Manifest diff, CI, deploying | [Manifest diff and CI](manifest/diff-and-ci.md), [Deploying](manifest/deploying.md) |
| Route arguments and validation | [Route arguments](http/04-route-arguments.md), [DTO constraints](validation/09-dto-constraints-jsdoc.md), [`@spinajs/validation`](validation/README.md) |
| Errors | [Error handling](http/11-error-handling.md) |
| Client | [`@spinajs/client`](client/README.md) |
| OpenAPI, AsyncAPI | [`@spinajs/openapi`](openapi/README.md), [`@spinajs/asyncapi`](asyncapi/README.md) |
| Sockets | [`@spinajs/http-socket`](http-socket/README.md), [Typed contracts](http-socket-common/06-typed-contracts.md) |
| Testing | [`@spinajs/testing`](testing/README.md) |
| Configuration | [`@spinajs/configuration`](configuration/README.md) |
| DI | [`@spinajs/di`](di/README.md) |
