# `@spinajs/compiler`

Build-time analyzer. It reads a package's TypeScript source through its `tsconfig`, finds what the framework would otherwise discover at runtime (services, routes, models, commands and so on) and writes it down as a manifest. It never executes user code and never boots the DI container.

Two entry points:

- `analyzePackage` turns one package into a `ManifestFragment`.
- `buildAppManifest` analyzes the application, collects the fragments its dependencies ship, and merges everything into `app.manifest.json`.

The manifest types, the JSON Schema, `mergeFragments` and `hashManifest` live in [`@spinajs/manifest`](../manifest/README.md). This package only produces data in that shape.

## Install

```sh
npm install --save-dev @spinajs/compiler
```

## `analyzePackage`

```text
analyzePackage({ tsconfig, packageRoot, schemaDerivation? }): Promise<ManifestFragment>
```

| Option | Meaning |
| --- | --- |
| `tsconfig` | Path to the `tsconfig` that lists the package sources. Files under its `rootDir` (default: the `tsconfig` folder) that are not declaration files are analyzed. |
| `packageRoot` | Folder with the package's `package.json`. Every `source.file` in the result is relative to it, with forward slashes. |
| `schemaDerivation` | Accepted for forward compatibility. It has no effect yet: extractors do not derive JSON Schemas from types. |

The fragment's `package` member comes from `package.json` and the `tsconfig`:

| Member | Source |
| --- | --- |
| `name`, `version` | `package.json` |
| `entry` | `package.json#main` without a leading `./`, default `lib/index.js` |
| `outDir` | `compilerOptions.outDir` relative to `packageRoot`, default `lib` |

### Determinism

The same sources always give the same fragment. Source files are visited in path order, each section is sorted by `source.file`, then `source.line`, then `source.col`, and diagnostics are sorted the same way (those without a source come first). Services found in several files are merged when `id`, `lifetime` and `condition` all match; their `registeredAs` lists are united.

## `buildAppManifest`

```text
buildAppManifest({ tsconfig, appRoot, out?, schemaDerivation? }): Promise<{ manifest, written }>
```

1. Analyzes the application with `analyzePackage`.
2. Calls `locateFragments(appRoot)` to find the fragment of every entry in the app's `dependencies`.
3. Reads and validates each fragment, then calls `mergeFragments`. Dependencies come first, the application last, so the application wins where the last registration wins at runtime.
4. Computes `hash` with `hashManifest` and writes the file. `out` defaults to `<appRoot>/app.manifest.json`.

`manifest.app.outDir` and each `manifest.packages[].outDir` are the compiled output folders (`compilerOptions.outDir` of the respective `tsconfig`, relative to its package root). `packages[].fragment` is relative to `app.root` with forward slashes: `node_modules/<name>/<spinajs.manifest>` when the package is installed under the app, the relative real path when it is hoisted above it. `app.root` itself is absolute but excluded from `hash`, so the hash is the same on every machine and checkout. `generatedAt` is the only other member that differs between two runs on the same sources; it is excluded from `hash`.

## The fragment contract

A package that wants to take part in an app manifest ships its fragment and points to it from `package.json`:

```json
{
  "name": "my-package",
  "version": "1.0.0",
  "main": "lib/index.js",
  "spinajs": { "manifest": "lib/manifest.fragment.json" }
}
```

`locateFragments` resolves each dependency's `package.json` (through Node resolution, falling back to `node_modules/<name>`), reads `spinajs.manifest` and returns `{ name, version, entry, fragment }` with an absolute `fragment` path. A dependency without the field, or whose fragment file does not exist, is skipped silently. Only packages listed under `dependencies` are considered.

## What is extracted

| Section | Recognized source | Notes |
| --- | --- | --- |
| `services` | `@Injectable()` classes; `DI.register(X).as(...)`, `.asSelf()`, `.singleInstance()` chains | Records `registeredAs`, lifetime, `async` (`AsyncService`), `bootstrapper`, `@Inject` constructor tokens, injected properties, and `DI.resolve(...)` calls inside methods. |
| `values` | `.asValue(...)`, `.asMapValue(...)` on a register chain; `registerConfigurationSchema` calls | Token and, for maps, the map key. |
| `controllers`, routes, params | Classes extending `BaseController`; `@BasePath`; `@Get`, `@Post`, `@Put`, `@Patch`, `@Del`, `@Head`; parameter decorators such as `@Query`, `@Body`, `@Param`, `@Header`, `@File`, `@Form`, `@Cookie`, `@PKey`, `@Uuid` | Policies (`@Policy`), middlewares, `@Access` and `@AllowAnonymous` are recorded at class and route level. The return type is unwrapped from `Promise` and the transparent response wrappers. JSDoc tags (`@summary`, `@description`, `@tags`, `@deprecated`, `@response`) fill `doc`. |
| `socketControllers` | `@SocketController`, `@Command`, `@OnEvent`, `@Payload`, `@SocketPolicy`, `@SocketAccess` | Command options (`idempotent`, `ordered`, `timeoutMs`) are kept when literal. |
| `socketContracts` | `const X = defineContract<T>()` with a type argument describing `commands` (payload and result tuples), `events` and `clientEvents` | Payload and result types are recorded as type references. |
| `configModules` | `registerConfigurationSchema` and the at-import variant with a literal schema | Needs `$id` and `$configurationModule` on the schema. `defaultsFile` is set when `src/config/<module>.ts` exists. |
| `configUsages` | `@Config('a.b')` or `@AutoinjectService('a.b')` on a property; `.get('a.b')` on a configuration object, with a literal path | One entry per use. |
| `models` | `@Model`, `@Connection`, `@AccessResource`; `@Primary`, `@BelongsTo`, `@ForwardBelongsTo`, `@HasMany`, `@HasManyToMany` | Columns are class fields; `@Virtual`, `@Query` and `@Historical` fields are skipped. |
| `migrations` | `@Migration(connection, { Env })` | `env` is always a list. |
| `schedules` | `@Schedule(name, options)` | |
| `commands` | Classes extending `CliCommand` with `@Command`, `@Option` and `@Argument` | Name is the first word of the command string. |
| `queueMessages` | `@Job`, `@Event` classes | `kind` is `job` or `event`; the payload is the class type. |

### Conditions

A service, value or controller that is registered conditionally carries a `condition`. A registration guarded by a `@Config` property or a `config.get(...)` check becomes `{ kind: 'config', path, expected? }`. Anything the analyzer cannot decide (loops, arbitrary expressions, registration inside `bootstrap()` without a guard) becomes `{ kind: 'dynamic', reason }` with a `CMP003` diagnostic. Such entries are kept, never dropped.

## Schema derivation

With `schemaDerivation` on (the default), every route parameter and response, socket payload and result, queue message and model column gets a JSON Schema (draft-07) derived from its TypeScript type. Named classes, interfaces and enums are hoisted under `spinajs/<package>/<Name>` and referenced by `$ref`; anonymous types are inlined. These rules decide what is derived and how:

| Type | Schema |
| --- | --- |
| `@Req()`, `@Res()`, `@FromDI()` and file parameters | None. The framework supplies the value, so the parameter keeps only its type text. |
| `Promise<T>`, `Ok<T>` and the other transparent wrappers | The schema of `T`. A wrapper without a type argument (`Ok`, `Ok<any>`) is bare: type text only, no schema. |
| A class extending the `@spinajs/http` `Response` | A response wrapper, matched by the declaring package. http's generic responses (`ForbiddenResponse<T>`, ...) unwrap to their first type argument, a non-generic one to its base class argument (`BufferResponse` to `Buffer`). `Response`, `Response<any>` and a route returning a union of responses (`Ok \| Unauthorized`) are bare; document those with `@response` tags. |
| A class | Its public data members. Private, protected and `#private` fields, methods and function-typed members are left out. |
| A model (a class extending `@spinajs/orm` `ModelBase`) | Its columns, closed with `additionalProperties: false`. The columns are the ones the manifest `models` section lists: public data members of the class and its bases below `ModelBase`, writable accessors included, get-only accessors and function-typed members left out. A relation (a relation decorator, or a `Relation`/`SingleRelation` type) is optional: `SingleRelation<M>` becomes a `$ref` to `M`, `Relation<M, O>` an array of it, a decorated member typed `M` a `$ref` to `M`. `@Hidden`, `@Virtual`, `@Query` and `@Historical` members are left out. A model read from a declaration file (a dependency's model, such as `User` from `@spinajs/users`), or one extending such a class, derives to an open `{ type: 'object' }` with an `SCH001` info: declaration files carry no decorators, so a column list would publish its `@Hidden` columns. |
| `ModelData<M>`, `ModelDataWithRelationData<M>` | The schema of the model `M`, wherever the type appears. |
| A template literal type | `{ type: 'string' }`. When every placeholder is `${string}`, a `pattern` keeps the fixed text: `` `native:${string}` `` gives `^native:`, `` `${string}.json` `` gives `\.json$`. Other placeholders (`${number}`) give no pattern. `Uppercase<string>` and the other string mappings give a plain string. |
| A union or intersection alias | Inlined, unless it refers to itself. A recursive alias (`type Filter = { not: Filter } \| ...`) is hoisted under its name, so the recursion ends in a `$ref`. An optional (`arg?: Filter`) or nullable (`arg: Filter \| null`) self-reference closes the same way; `null` adds `anyOf: [{ $ref }, { type: 'null' }]`. |

## Diagnostics

Every diagnostic has a `code`, a `severity` (`error`, `warning`, `info`), a `message` and, when it points at code, a `source`.

| Code | Severity | Meaning |
| --- | --- | --- |
| `CMP001` | info | A decorator argument is not a literal, so the value is `undefined` in the manifest. |
| `CMP002` | info | A `@response` JSDoc tag could not be parsed. |
| `CMP003` | info | A registration has a dynamic condition. |
| `CFG010` | warning | A configuration schema is not a literal with `$id` and `$configurationModule`. |
| `SCH001` | warning / info | A type has no JSON Schema form and is emitted as `{}`: `any`, a function, `symbol`, `never`. Give the member a real type. `unknown`, `object` and an `any` index signature are `info`: the value is accepted as is, which suits an opaque value. A model read from a declaration file is `info` too (see the model row above). A type declared outside the package says where in the message (`declared in X`). |
| `SCH002` | warning | A type nests deeper than the depth limit (20) and the cut is emitted as `{}`. Usually a framework type reached through a member; a recursive alias no longer causes it. |
| `SCH003` | warning | An explicit `@Schema` differs from the schema derived from its class (reported by `spinajs doctor`). Align the schema and the class. |
| `SCH005` | warning | Two different types derive to the same schema `$id`. Rename one of them. |

Run `node packages/compiler/scripts/report-diagnostics.mjs <packageDir> [--fail-on CODE,...]` to list one package's diagnostics with a count per code and severity. `--fail-on` exits 1 when a listed code occurs as a `warning` or an `error`; `info` never fails it.

`runDoctor` runs consistency rules over a manifest and is exported from the same package.

## TypeScript version

The analyzer depends on `typescript` pinned to `~5.9.0` and uses the in-process compiler API. It does not use the application's compiler. An application can build with TypeScript 7 while the analyzer reads the same sources with 5.9; the package's tests type-check a fixture with TypeScript 7 and compare the 5.9 analysis with a stored snapshot to catch drift in what the two accept.

## Related pages

- [doctor](doctor.md)
