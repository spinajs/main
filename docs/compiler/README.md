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
2. Calls `locateFragments(appRoot)` to find the fragment of every package in the app's installed dependency closure.
3. Reads and validates each fragment, then calls `mergeFragments`. Dependencies come first, the application last, so the application wins where the last registration wins at runtime.
4. Computes `hash` with `hashManifest` and writes the file. `out` defaults to `<appRoot>/app.manifest.json`.

`manifest.app.outDir` and each `manifest.packages[].outDir` are the compiled output folders (`compilerOptions.outDir` of the respective `tsconfig`, relative to its package root). `packages[].fragment` is relative to `app.root` with forward slashes: `node_modules/<name>/<spinajs.manifest>` when the package is installed under the app, the relative real path when it is found elsewhere. `app.root` itself is absolute but excluded from `hash`, so the hash is the same on every machine and checkout. `generatedAt` is the only other member that differs between two runs on the same sources; it is excluded from `hash`.

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

`locateFragments` finds each dependency's `package.json` (in the app's or an ancestor `node_modules`, so hoisted workspace installs and packages whose `exports` hide `package.json` work; Node resolution is the fallback), reads `spinajs.manifest` and returns `{ name, version, entry, fragment }` with an absolute `fragment` path. A dependency without the field, or whose fragment file does not exist, is skipped silently.

The packages considered are the app's installed dependency closure: `dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies` of the app, then `dependencies`, `optionalDependencies` and `peerDependencies` of each package found, transitively. A package without a fragment is walked through, since it can depend on one that has a fragment. Each dependency resolves from the real directory of the package that declares it, as Node resolves it. One that is not installed (an optional or peer dependency) is skipped, and a cycle ends at a package already visited. Each package found is then located from the app root, so the list matches what the runtime and the config walk see: a package installed only inside another package's `node_modules` is left out. The result is sorted by name. A dependency's own `devDependencies` are never followed. The manifest may list more than a given install holds (a pruned production install lacks the devDependencies); the runtime skips a listed package that is not installed.

## What is extracted

| Section | Recognized source | Notes |
| --- | --- | --- |
| `services` | `@Injectable()` classes; `DI.register(X).as(...)`, `.asSelf()`, `.singleInstance()` chains | Records `registeredAs`, lifetime, `async` (`AsyncService`), `bootstrapper`, `@Inject` constructor tokens, injected properties, and `DI.resolve(...)` calls inside methods. |
| `values` | `.asValue(...)`, `.asMapValue(...)` on a register chain; `registerConfigurationSchema` calls | Token and, for maps, the map key. |
| `controllers`, routes, params | Classes extending `BaseController`; `@BasePath`; `@Get`, `@Post`, `@Put`, `@Patch`, `@Del`, `@Head`; parameter decorators such as `@Query`, `@Body`, `@Param`, `@Header`, `@File`, `@Form`, `@Cookie`, `@PKey`, `@Uuid` | Policies (`@Policy`), middlewares, `@Access` and `@AllowAnonymous` are recorded at class and route level. The return type is unwrapped from `Promise` and the transparent response wrappers. JSDoc tags (`@summary`, `@description`, `@tags`, `@deprecated`, `@response`) fill `doc`. `fullPath` is the path `@spinajs/http` serves (`routeFullPath`, without `http.controllers.route.prefix`), `mountPath` the effective base, and each parameter's `wire` says how a client sends it (see below). |
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

### Route paths and wire format

`fullPath` is the request path the route answers at: `servedPath(routeFullPath(mountPath, path, handler))`. `routeFullPath` is the function `@spinajs/http` mounts routes with: a bare or empty route path falls back to the handler name (`@Get()` on `list()` under `users` is `/users/list`), `@Get('/')` is the base itself, and parts are joined as written, so a leading slash gives `//`. `servedPath` strips trailing slashes, as the router does when it matches a route: `@BasePath('/')` + `@Get('/')` is mounted as `//` but answers at `/` (a request for `//` is a 404), so its `fullPath` is `/`. `mountPath` is the `@BasePath` value, the lower-cased class name without one, or the default of a configured base path without its outer slashes. With `http.controllers.route.prefix`, the path is `servedPath(withRoutePrefix(prefix, fullPath))`.

`kind` is the `ParameterType` the runtime registers the argument under: `@AsModel` is `AsDbModel` and `@FromModel` is `FromDbModel` (orm-http), `@FromXml` is `FromXmlRouteArgs`, `@Req`/`@Res` are `ArgAsRequest`/`ArgAsResponse`, and `@PKey(X)`/`@Uuid(X)` record `X` (`FromParams` without it).

`wire` follows the route-arg that binds the parameter. "Scalar" is a type of one primitive family (string, number, boolean, bigint, their literals and enums; `null`/`undefined` ignored), luxon `DateTime`, or a built-in constructor other than `Object`/`Array`; anything else is parsed with `JSON.parse` by the server. A built-in constructor such as `Date` is not converted at all: `@Query() since: Date` hands the handler the string as sent (no `format` is recorded, the server applies none), so type it as `string` or luxon `DateTime` to say what it is.

| Decorator | `in` | `name` | `shape` |
| --- | --- | --- | --- |
| `@Query()` | `query` | parameter name | `value` when scalar, else `json` |
| `@QueryField()` | `query` | | `whole` (flat keys, string values) |
| `@Param()`, `@PKey()`, `@Uuid()` | `path` (`@PKey(ParameterType.X)`: that location) | parameter name; `_name` is recorded as `name` when only `:name` is in the path (`FromParams` falls back to it) | `value` when scalar, else `json` |
| `@ParamField()` | `path` | | `whole` |
| `@Header(key?)` | `header` | `key`, else the parameter name, lower-cased | `value` when scalar, else `json` |
| `@HeadersField()` | `header` | | `whole` |
| `@Cookie()` | `cookie` | parameter name | `value` when scalar, else `json` |
| `@Body()`, the only `FromBody` argument of the route, not scalar | `body` | | `whole` |
| `@Body()`, one of several `FromBody` arguments (`@PKey`/`@Uuid(ParameterType.FromBody)` count too), or scalar | `body` | parameter name | `field` (`body[name]`) |
| `@BodyField()`, `@RawBody()`, `@FromXml()` | `body` | | `whole` |
| `@File()`, `@CsvFile()`, `@JsonFile()` | `multipart` | parameter name | `value`; array type: `multiple: true` |
| `@Files()` | `multipart` | parameter name | `value`, `multiple: true` |
| `@FormField()` | `multipart` | parameter name | array type: `value`, `multiple: true`; else `value` when scalar, `json` otherwise |
| `@Form()` | `multipart` | | `whole` |
| orm-http `@FromModel({ paramType?, paramField? })` | `path`, or `paramType` | `paramField`, else the parameter name | `value` (`field` in the body) |
| orm-http `@AsModel(field?, type?)` | `body`, or `type` | `field`, else the parameter name | body: `whole` when it is the only one and has no `field`, else `field`; elsewhere `json` |
| `@FromDI()`, `@Req()`, `@Res()`, `@Ip()`, `@RequestId()`, `@UserAgent()`, `@Referer()`, `@AcceptType()`, `@Model()` | `none` | | `whole` |

## Schema derivation

With `schemaDerivation` on (the default), every route parameter and response, socket payload and result, queue message and model column gets a JSON Schema (draft-07) derived from its TypeScript type. Named classes, interfaces and enums are hoisted under `spinajs/<package>/<Name>` and referenced by `$ref`; anonymous types are inlined. These rules decide what is derived and how:

| Type | Schema |
| --- | --- |
| `@Req()`, `@Res()`, `@FromDI()` and file parameters | None. The framework supplies the value, so the parameter keeps only its type text. |
| `Promise<T>`, `Ok<T>` and the other transparent wrappers | The schema of `T`. A wrapper without a type argument (`Ok`, `Ok<any>`) is bare: type text only, no schema. |
| A class extending the `@spinajs/http` `Response` | A response wrapper, matched by the declaring package. http's generic responses (`ForbiddenResponse<T>`, ...) unwrap to their first type argument, a non-generic one to its base class argument (`BufferResponse` to `Buffer`). `Response`, `Response<any>` and a route returning a union of responses (`Ok \| Unauthorized`) are bare; document those with `@response` tags. |
| A class | Its public data members. Private, protected and `#private` fields, methods and function-typed members are left out. |
| A model (a class extending `@spinajs/orm` `ModelBase`) | Its columns, closed with `additionalProperties: false`. The columns are the ones the manifest `models` section lists: public data members of the class and its bases below `ModelBase`, writable accessors included, get-only accessors and function-typed members left out. A relation (a relation decorator, or a `Relation`/`SingleRelation` type) is optional: `SingleRelation<M>` becomes a `$ref` to `M`, `Relation<M, O>` an array of it, a decorated member typed `M` a `$ref` to `M`. `@Hidden`, `@Virtual`, `@Query` and `@Historical` members are left out. A model read from a declaration file (a dependency's model, such as `User` from `@spinajs/users`), or one extending such a class, derives to an open `{ type: 'object' }` with an `SCH001` info: declaration files carry no decorators, so a column list would publish its `@Hidden` columns. |
| A type built from a model's members (`Partial<M>`, `Pick<M, K>`, `Omit<M, K>`, `Readonly<M>`, `Required<M>`, `Partial<ModelData<M>>`, an interface extending `M`) | The model rules apply per member, by the class that declares it. A member of a model read from a declaration file makes the whole object an open `{ type: 'object' }` with an `SCH001` info. A member of an in-program model is published only when the model's own schema has it: `@Hidden`, computed and `ModelBase` members are left out, and relations keep their relation schema and are never required. A key-remapping mapped type (`` { [K in keyof M as `get${K}`]: M[K] } ``, `Uppercase` keys) follows the original member under its new name. When a value that depends on the key cannot be traced to the member it reads (a literal key union such as `{ [K in 'Id' \| 'Password']: M[K] }`), the whole object is an open `{ type: 'object' }` with an `SCH001` info. Known limits: `Record<keyof M, V>` publishes every member *name* of `M` (with values of type `V`), and an indexed type the checker has already resolved (`M['Password']`, `Record<'pw', M['Password']>`) is plain `string`, so no member origin is left to check. |
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
| `CMP005` | info | A route argument read from one string (query key, url segment, header, cookie, form field) has a type converted by a custom `@Hydrator`, which receives the raw string. Its `wire.shape` is recorded as `value`; the hydrator decides the real format. |
| `CFG010` | warning | A configuration schema is not a literal with `$id` and `$configurationModule`. |
| `SCH001` | warning / info | A type has no JSON Schema form and is emitted as `{}`: `any`, a function, `symbol`, `never`. Give the member a real type. `unknown`, `object` and an `any` index signature are `info`: the value is accepted as is, which suits an opaque value. A model read from a declaration file is `info` too (see the model row above). A type declared outside the package says where in the message (`declared in X`). |
| `SCH002` | warning | A type nests deeper than the depth limit (20) and the cut is emitted as `{}`. Usually a framework type reached through a member; a recursive alias no longer causes it. |
| `SCH003` | warning | An explicit `@Schema` differs from the schema derived from its class (reported by `spinajs doctor`). Align the schema and the class. Entries marked `x-explicit: partial` (see `SCH006`) are skipped. |
| `SCH004` | warning | A `@Schema` argument is a Standard Schema (an object with a `~standard` member, such as `z.object(...)`) whose JSON Schema the compiler cannot read. The compiler never runs the schema. For zod 4 or newer, export a literal JSON Schema from the DTO's file as `export const <Name>JsonSchema = { ... }` and the compiler publishes it like an explicit `@Schema` (the export must be a literal: `export const <Name>JsonSchema = z.toJSONSchema(...)` is `SCH006`, because the compiler never executes user code; an opt-in generator step that writes the literal is a planned follow-up). `zod/v4` and `zod/v4-mini` imports count as zod 4 whatever the package version. A Standard Schema defined in your own package is reported as a locally defined schema. Other libraries and zod 3 expose nothing to read. In every `SCH004` case the schema derived from the class is published, marked `x-explicit: 'partial'` (documentation only: manifest request validation and contract tests accept anything there, also where another schema references it), and request validation still runs the Standard Schema. |
| `SCH005` | warning | Two different types derive to the same schema `$id`. Rename one of them. Generic arguments are part of the id (`Page<Point>` is `Page_Point`; an array argument adds `_Array`, a tuple is `Tuple_A_B`), so two instantiations of one generic never collide. |
| `SCH006` | warning | An explicit `@Schema` argument cannot be fully evaluated at build time: a spread of a call (`...bodyOf(...)`), a `.map(...)`, a computed key or any other non-literal part. The message names each part. Publishing what was read would document a truncated contract, so the schema derived from the class is published instead, with the explicit `title` and `description` and `'x-explicit': 'partial'`; runtime validation still uses the real `@Schema` object. A partial entry is documentation and typing only: request validation and contract tests must not treat it as authoritative; the runtime `@Schema` object is what validates. Make the argument a literal (or a `const` of one) to publish it. |

Run `node packages/compiler/scripts/report-diagnostics.mjs <packageDir> [--fail-on CODE,...]` to list one package's diagnostics with a count per code and severity. `--fail-on` exits 1 when a listed code occurs as a `warning` or an `error`; `info` never fails it.

### Known findings in the framework packages

The triage of `users-http`, `teams-http` and `authz-http-admin` left these diagnostics open. `teams-http` has none.

| Code | Where | Cause | Fix |
| --- | --- | --- | --- |
| `SCH003` | `users-http` `UserMetadataDto` (`src/dto/metadata-dto.ts`) | The schema makes `Value` optional (`required: [Key, Type]`), the class declares it required. The schema types `Type` as `{ type: 'string', enum: [...] }`, the class as a literal union, which the drift rule reads as an enum. | Declare `public Value?: string`. For `Type`, drop `type: 'string'` from the schema (the `enum` alone says the same), or teach the drift rule that a string `enum` matches a literal union. |
| `SCH003` | `users-http` `arrow.common.banUserDTO` (`BanUserDto`, `Security.ts`) and `arrow.common.updateUserDto` (`UpdateUserDto`, `Users.ts`) | `reauthPassword` is in the schema (the fresh-authentication password) but not on the class. | Declare `public reauthPassword?: string` on both classes. |
| `SCH006` (was false `SCH003`) | `authz-http-admin` `AuthzAssignmentGrant`, `AuthzAssignmentPatch`, `AuthzLinkCreate`, `AuthzLinkPatch`, `AuthzRuleBody`, `AuthzPolicyBody` (`src/dto`) | Each schema is built at runtime (`{ ...bodyOf(...), description }`, `anyOf: KEYS.map(...)`). The analyzer cannot evaluate those parts, so the manifest publishes the schema derived from each class, marked `x-explicit: partial`, and `SCH003` skips them. | Export the bodies as literal schemas if the published contract must carry their exact constraints (`anyOf`, descriptions per field). |
| `SCH001` warning | `@spinajs/orm` `MetadataModel.Value` (`orm/src/metadata.ts`), reached through `users-http` `FilterableUserMetadata` | The `Value` accessor is typed `any`. | Type it `unknown` in `@spinajs/orm`. Out of scope for the triage: the type change reaches every metadata consumer. |
| `SCH001` info | `users-http` (5) and `authz-http-admin` (4) | Opaque by design: `unknown` values (`UserProfile.AdditionalData`, `CreateUserDto.Metadata`, link `attributes`) and models read from `@spinajs/users` declaration files (`User`, `UserMetadataBase`, `FilterableUserMetadata`). | None needed. |

`runDoctor` runs consistency rules over a manifest and is exported from the same package. The route rules (`HTTP001`, `HTTP003`, `HTTP004`, `HTTP005`) are listed in [doctor](doctor.md).

## TypeScript version

The analyzer depends on `typescript` pinned to `~5.9.0` and uses the in-process compiler API. It does not use the application's compiler. An application can build with TypeScript 7 while the analyzer reads the same sources with 5.9; the package's tests type-check a fixture with TypeScript 7 and compare the 5.9 analysis with a stored snapshot to catch drift in what the two accept.

## Related pages

- [doctor](doctor.md)
