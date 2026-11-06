export const MANIFEST_VERSION = 2 as const;

export interface SourceRef { file: string; line: number; col: number; package: string }

export type Condition =
  | { kind: 'config'; path: string; expected?: unknown }   // registered only when config at `path` is truthy / equals expected
  | { kind: 'dynamic'; reason: string };                    // analyzer could not decide; doctor reports it

export type Lifetime = 'singleton' | 'new-instance' | 'per-child' | 'per-instance' | 'per-instance-check';

export interface ServiceEntry {
  id: string;                       // `${package}:${className}`
  className: string;
  registeredAs: string[];           // DI keys (class names or string tokens) this class is bound to; includes itself when asSelf
  lifetime: Lifetime;
  async: boolean;                   // extends AsyncService
  bootstrapper: boolean;            // extends Bootstrapper
  ctorInjects: string[];            // DI keys from @Inject, positional
  /** Parallel to `ctorInjects`: the token is a non-abstract class, which the container constructs even without a registration. Omitted when no entry is true. */
  ctorConcrete?: boolean[];
  /** `concrete`: the injected type is a non-abstract class; `check`: injected with `{ check: true }`, which throws when unregistered. */
  propertyInjects: PropertyInject[];
  /** Imperative DI.resolve(X) calls inside methods; `awaited:false` on an async provider is doctor DI003. */
  imperativeResolves?: { token: string; method: string; awaited: boolean; source: SourceRef }[];
  condition?: Condition;
  source: SourceRef;
}

/** `tokenRef`: the declared property type, recorded when the decorator names no type. */
export interface PropertyInject { property: string; token: string; optional: boolean; array: boolean; lazy?: boolean; concrete?: boolean; check?: boolean; tokenRef?: RuntimeTypeRef }

/** What `design:type` would hold for the injected properties of one class. Only a package built without decorator metadata has these. */
export interface ClassPropertiesEntry { id: string; className: string; properties: PropertyInject[]; source: SourceRef }

export interface ValueEntry { token: string; kind: 'value' | 'map'; mapKey?: string; value?: unknown /* literal when known; __http_error_map__: { response: string; status?: number } */; source: SourceRef; condition?: Condition }

export interface TypeRef {
  /** Canonical display name, e.g. 'Promise<Ok<UserDto[]>>' unwrapped to the payload */
  text: string;
  /** `$id` of the derived schema in `schemas`, when derivation succeeded (C1); absent in B-only builds */
  schema?: string;
  /** The runtime value `emitDecoratorMetadata` would record for the type; set on route arguments, socket payloads and property injections only. */
  ref?: RuntimeTypeRef;
  /** Why a class has no `ref`, for the error of a build without decorator metadata: not exported, or in a package without a manifest fragment. */
  refProblem?: string;
}

/**
 * Where a runtime type lives. `package: 'global'` (with `file: ''`) names a global constructor such as `Number` or `Date`;
 * otherwise `file` is package-relative, `src/x.ts` in the package's own source or the built `lib/x.js` of a dependency.
 */
export interface RuntimeTypeRef { package: string; file: string; export: string }

/**
 * `ParamEntry.kind` of a parameter under a decorator the compiler does not know (`@Filter`, `@CurrentUser`, an app's own
 * `Parameter()`): its runtime type is recorded, how it binds is not, so it never counts as a wire argument (`wire.in: 'none'`).
 */
export const DECORATED_PARAM_KIND = 'Decorated';

/** `none`: injected by the framework or set by the user agent (`FromDi`, `Req`, `Ip`, `UserAgent`, ...), not part of a call. */
export type WireLocation = 'query' | 'path' | 'body' | 'header' | 'cookie' | 'multipart' | 'none';

/**
 * - `value`: one plain string under `name` (a primitive, literal union or enum; a file part; a hydrated type such as luxon `DateTime`).
 * - `json`: `JSON.stringify(value)` under `name` (a class, object, array, `any` or mixed union read from a query key, url segment, header or cookie).
 * - `whole`: the argument is the container itself: the whole query (flat, string values), params, headers, form, or body.
 * - `field`: `body[name]` (one of several `@Body` arguments, or a primitive single `@Body`).
 */
export type WireShape = 'value' | 'json' | 'whole' | 'field';

/** How a client sends a route argument, as the `@spinajs/http` route-arg that reads it binds it. */
export interface ParamWire {
  in: WireLocation;
  /** Key on the wire; absent for `whole`. A header name is lower-cased. */
  name?: string;
  shape: WireShape;
  /** Repeated parts or fields under `name` (`@Files`, an array `@FormField`). */
  multiple?: true;
}

export interface ParamEntry {
  index: number;
  name: string;                      // from the AST, replaces cache.ts
  kind: string;                      // the ParameterType the runtime registers it under: 'FromBody', 'FromQuery', 'FromDi', 'ArgAsRequest', orm-http 'AsDbModel', …
  runtimeType: TypeRef;
  required: boolean;
  options?: unknown;                 // decorator options object when it is a literal
  schema?: string;                   // explicit @Body/@Query schema `$id` (inline schemas are hoisted into `schemas`)
  /** Absent in fragments older than the field. */
  wire?: ParamWire;
}

export interface PolicyRef { type: string; options?: unknown[] }

export interface RouteEntry {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'file';
  path: string;
  handler: string;                   // method name
  /**
   * The request path the route answers at, `servedPath(routeFullPath(mountPath, path, handler))`, without the global
   * `http.controllers.route.prefix`: with one, it is `servedPath(withRoutePrefix(prefix, fullPath))`. A `basePathConfig`
   * controller uses its default.
   */
  fullPath: string;
  params: ParamEntry[];
  returnType: TypeRef;
  policies: PolicyRef[][];           // groups: OR between groups, AND inside
  middlewares: { type: string; options?: unknown[] }[];
  access?: string[];                 // @Access permissions (authz-http)
  allowAnonymous?: boolean;
  public?: string;                   // @Public reason (http)
  doc?: { summary?: string; description?: string; tags?: string[]; deprecated?: boolean; responses?: { status: number; description?: string; type?: TypeRef }[] };
  /** Id of the controller entry that declared the route, when the controller inherits it. */
  inheritedFrom?: string;
  source: SourceRef;
}

/**
 * On an app's class outside the `system.dirs` of its section. The entry keeps the class's metadata, but the manifest never
 * loads the class: it runs only if something registers it (an import, `DI.register`, a source, `Controllers.add`), as in discovery.
 */
export type MountedBy = 'di';

/**
 * On a schedule, socket controller or migration its module does not export. These register as the module is evaluated, so
 * the import is enough; any other class missing from its module means the manifest is stale.
 */
export type NotExported = false;

export type ManifestSection = 'controllers' | 'socketControllers' | 'schedules' | 'commands' | 'migrations';

/**
 * A file a directory scan of the section imports and no loaded entry of it brings in. The manifest imports it as well: the
 * scan runs its decorators and registrations.
 */
export interface ScanFile {
  section: ManifestSection;
  source: SourceRef;
}

export interface ControllerEntry {
  id: string; className: string;
  basePath: string | null; basePathConfig?: string;   // as declared; null without @BasePath
  /** Effective base the routes are mounted under (`controllerMountPath`); absent in fragments older than the field. */
  mountPath?: string;
  policies: PolicyRef[][]; middlewares: { type: string; options?: unknown[] }[];
  access?: string[]; allowAnonymous?: boolean;   // class-level @Access / @AllowAnonymous
  public?: string;                   // class-level @Public reason
  routes: RouteEntry[];
  /** Ids of the ancestor entries whose routes and guards are merged into this one, nearest first. */
  bases?: string[];
  condition?: Condition;
  mountedBy?: MountedBy;
  source: SourceRef;
}

export interface SocketCommandEntry { name: string; handler: string; payload: TypeRef; result: TypeRef; /** The handler returns an async iterable; `result` describes one item */ stream?: true; options: { idempotent?: boolean; ordered?: 'connection' | 'client'; timeoutMs?: number }; access?: string[]; /** `@SocketAccess(…, { fields })`: the result is redacted per the decision's field set ( 'filter-rows': per row ) */ fields?: 'filter' | 'filter-rows'; policies: PolicyRef[][]; /** Index of the `@Payload` argument, which a subclass re-types through generics */ payloadIndex?: number; inheritedFrom?: string; source: SourceRef }
/** `handler`: the method that handles the event; absent in fragments older than the field. */
export interface SocketEventEntry { name: string; handler?: string; payload: TypeRef; payloadIndex?: number; inheritedFrom?: string }
export interface SocketControllerEntry { id: string; className: string; prefix: string; /** `id` of the `socketContracts` entry named by `@SocketController(prefix, { contract })` */ contract?: string; commands: SocketCommandEntry[]; events: SocketEventEntry[]; /** The declared type of every `@FromDI()` parameter, hooks included; omitted when there is none. */ diArgs?: { handler: string; index: number; ref?: RuntimeTypeRef; refProblem?: string }[]; /** Ids of the ancestor entries whose handlers are merged into this one, nearest first. */ bases?: string[]; mountedBy?: MountedBy; exported?: NotExported; source: SourceRef }
export interface SocketContractCommand { payload: TypeRef; result: TypeRef }
export interface SocketContractEntry { id: string; /** Name the `defineContract` variable is exported under; lets a dependent package resolve a contract it imports */ exportName?: string; commands: Record<string, SocketContractCommand>; events: Record<string, TypeRef>; clientEvents: Record<string, TypeRef>; source: SourceRef }

export interface ConfigModuleEntry { module: string; schemaId: string; defaultsFile?: string; source: SourceRef }
export interface ConfigUsageEntry { path: string; source: SourceRef }   // every @Config('x.y') / config.get('x.y') literal

/** D8 type families. `migrate-diff` compares an inferred column by family only. `enum` is never inferred; only `@Column({ family: 'enum' })` produces it. */
export type ColumnFamily = 'integer' | 'bigint' | 'decimal' | 'float' | 'text' | 'boolean' | 'date' | 'datetime' | 'time' | 'json' | 'binary' | 'uuid' | 'enum';

/**
 * `default`: a literal, or `{ raw }` SQL such as `CURRENT_TIMESTAMP`. `inferred`: the family was not stated (no `@Column`,
 * or one without `family`) and comes from the TypeScript type; the other members are always what the decorator states.
 */
export interface ColumnSqlSpec {
  family: ColumnFamily;
  nativeType?: string;
  length?: number;
  precision?: number;
  scale?: number;
  unsigned?: boolean;
  default?: string | number | boolean | null | { raw: string };
  autoIncrement?: boolean;
  unique?: boolean;
  enumValues?: string[];
  version?: boolean;
  inferred?: boolean;
}

export interface ModelIndex { name?: string; columns: string[]; unique: boolean }

export interface ModelColumn {
  name: string;
  type: TypeRef;
  primary: boolean;
  nullable: boolean;
  /** Absent in fragments older than the field. */
  sql?: ColumnSqlSpec;
}

/**
 * Join columns as the decorator states them or the runtime defaults them to a name. An absent `primaryKey` is the primary
 * key of the target (`belongsTo`, `forwardBelongsTo`) or of the owner (`hasMany`, `hasManyToMany`); an absent `foreignKey`
 * of a `hasManyToMany` is the target's primary key.
 */
export interface ModelRelation {
  name: string;
  kind: 'belongsTo' | 'hasMany' | 'hasManyToMany' | 'forwardBelongsTo';
  target: string;
  foreignKey?: string;
  primaryKey?: string;
  junction?: { model: string; sourceKey: string; targetKey: string };
}

export interface ModelEntry {
  id: string; className: string; tableName: string; connection?: string;
  columns: ModelColumn[];  // declared via decorators / class fields only
  relations: ModelRelation[];
  indexes?: ModelIndex[];
  /** The `@Version` column. */
  version?: string;
  /** `@Model(table, { columns: 'exhaustive' })`: the model declares every column of its table (D19). */
  exhaustive?: true;
  accessResource: boolean;
  source: SourceRef;
}
export interface MigrationEntry { id: string; className: string; connection: string; env?: string[]; file: string; mountedBy?: MountedBy; exported?: NotExported; source: SourceRef }
export interface ScheduleEntry { name: string; className: string; options: Record<string, unknown>; mountedBy?: MountedBy; exported?: NotExported; source: SourceRef }
export interface CliCommandEntry { name: string; className: string; description?: string; options: { flags: string; description?: string }[]; arguments: { name: string; description?: string }[]; parent?: string; mountedBy?: MountedBy; source: SourceRef }
export interface QueueMessageEntry { className: string; kind: 'job' | 'event'; payload: TypeRef; options: Record<string, unknown>; source: SourceRef }

/** A column of a row type: `ts` is the TypeScript type text without `null`/`undefined`. */
export interface SqlRowColumn { name: string; ts: string; nullable: boolean }

/**
 * One `sql` template of `@spinajs/orm`. `text` has one `?` per interpolation. `dynamic`: it interpolates a fragment or
 * `sql.raw`, so the text is not the statement. `declaredColumns`: the properties of `R` in `sql<R>`. `lists`: indexes of
 * interpolations bound to an array, each of which expands to several values.
 */
export interface ModelSqlQuery {
  id: string;
  text: string;
  placeholders: number;
  dynamic: boolean;
  declaredRow?: TypeRef;
  declaredColumns?: SqlRowColumn[];
  lists?: number[];
  connection?: string;
  source: SourceRef;
}

/**
 * What a database driver hands back to raw SQL, declared by the driver with `@SqlDialect`. `families`: the TS type of a
 * column of that family when it is not the model's type. `sum`/`avg`: by the argument's family; a family not listed is
 * `unknown`. `'unknown'` anywhere: the driver's answer depends on more than this profile knows.
 */
export interface SqlDialectProfile {
  /** What an app writes in `package.json#spinajs.orm.dialects`. */
  name: string;
  /** The `database` option of node-sql-parser. */
  grammar: string;
  /** How the driver sends the `?` of the `sql` tag: unchanged, `$1..` or `@p0..`. */
  placeholders: 'question' | 'dollar' | 'at-p0';
  families: Partial<Record<ColumnFamily, string>>;
  count: string;
  sum: Partial<Record<ColumnFamily, string>>;
  avg: Partial<Record<ColumnFamily, string>>;
  /** A comparison, `TRUE` or `FALSE` in a select list. */
  predicates: string;
}

/** `drivers`: the `@Injectable` tokens of the class that declares the profile. */
export interface SqlDialectEntry { drivers: string[]; profile: SqlDialectProfile; source: SourceRef }

export interface Diagnostic { code: string; severity: 'error' | 'warning' | 'info'; message: string; source?: SourceRef }

export interface ManifestFragment {
  manifestVersion: typeof MANIFEST_VERSION;
  package: {
    name: string; version: string; entry: string /* relative to package root, e.g. lib/index.js */; outDir: string /* from tsconfig, maps src/x.ts to <outDir>/x.js */;
    /** Built files of `src/config/**`, relative to `outDir` (`config/x.js`). Absent in fragments older than the field. */
    configFiles?: string[];
  };
  services: ServiceEntry[]; values: ValueEntry[];
  controllers: ControllerEntry[]; socketControllers: SocketControllerEntry[]; socketContracts: SocketContractEntry[];
  /** Controllers nothing mounts (abstract, or outside the declared dirs); a subclass inherits their routes. Omitted when empty. */
  controllerBases?: ControllerEntry[];
  /** The same for socket controllers: abstract, undecorated or outside the declared dirs. Omitted when empty. */
  socketControllerBases?: SocketControllerEntry[];
  /** Omitted when empty, which it is for a package built with decorator metadata. */
  classProperties?: ClassPropertiesEntry[];
  configModules: ConfigModuleEntry[]; configUsages: ConfigUsageEntry[];
  models: ModelEntry[]; migrations: MigrationEntry[]; schedules: ScheduleEntry[]; commands: CliCommandEntry[]; queueMessages: QueueMessageEntry[];
  /** Omitted when there are none; only an app built with its dirs has any. */
  scanFiles?: ScanFile[];
  /** Omitted when the package has no `sql` template. */
  sqlQueries?: ModelSqlQuery[];
  /** Omitted when the package declares no SQL dialect. */
  sqlDialects?: SqlDialectEntry[];
  schemas: Record<string, unknown>;   // $id → JSON Schema
  diagnostics: Diagnostic[];
}

export interface Manifest extends Omit<ManifestFragment, 'package'> {
  app: { name: string; version: string; root: string; outDir: string };
  packages: { name: string; version: string; entry: string; outDir: string; fragment: string; configFiles?: string[] }[];
  /** The `APP_ENV` the build read the app's `system.dirs` under. Omitted by a build without configuration. */
  buildEnv?: string;
  /** `false` for `spinajs build --no-schemas`: the app's own types then have no schemas, its socket contracts included. */
  schemaDerivation?: false;
  /** Version of `@spinajs/compiler` that built the manifest; `manifest:diff` warns when base and head differ. Absent in manifests older than the field. */
  compilerVersion?: string;
  generatedAt: string;
  hash: string;                        // sha256 of canonical JSON with `hash`, `generatedAt` and `compilerVersion` blanked
}
