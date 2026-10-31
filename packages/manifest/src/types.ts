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

/** `tokenRef`: the declared property type, recorded when the decorator names no type, for a build without decorator metadata. */
export interface PropertyInject { property: string; token: string; optional: boolean; array: boolean; lazy?: boolean; concrete?: boolean; check?: boolean; tokenRef?: RuntimeTypeRef }

export interface ValueEntry { token: string; kind: 'value' | 'map'; mapKey?: string; value?: unknown /* literal when known; __http_error_map__: { response: string; status?: number } */; source: SourceRef; condition?: Condition }

export interface TypeRef {
  /** Canonical display name, e.g. 'Promise<Ok<UserDto[]>>' unwrapped to the payload */
  text: string;
  /** `$id` of the derived schema in `schemas`, when derivation succeeded (C1); absent in B-only builds */
  schema?: string;
  /** The runtime value `emitDecoratorMetadata` would record for the type; set on route arguments, socket payloads and property injections only. */
  ref?: RuntimeTypeRef;
}

/**
 * Where a runtime type lives. `package: 'global'` (with `file: ''`) names a global constructor such as `Number` or `Date`;
 * otherwise `file` is package-relative, `src/x.ts` in the package's own source or the built `lib/x.js` of a dependency.
 */
export interface RuntimeTypeRef { package: string; file: string; export: string }

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
  /** Omitted when the controller injects nothing into properties. */
  propertyInjects?: PropertyInject[];
  condition?: Condition;
  mountedBy?: MountedBy;
  source: SourceRef;
}

export interface SocketCommandEntry { name: string; handler: string; payload: TypeRef; result: TypeRef; /** The handler returns an async iterable; `result` describes one item */ stream?: true; options: { idempotent?: boolean; ordered?: 'connection' | 'client'; timeoutMs?: number }; access?: string[]; policies: PolicyRef[][]; source: SourceRef }
export interface SocketControllerEntry { id: string; className: string; prefix: string; /** `id` of the `socketContracts` entry named by `@SocketController(prefix, { contract })` */ contract?: string; commands: SocketCommandEntry[]; events: { name: string; payload: TypeRef }[]; /** Omitted when the controller injects nothing into properties. */ propertyInjects?: PropertyInject[]; mountedBy?: MountedBy; exported?: NotExported; source: SourceRef }
export interface SocketContractCommand { payload: TypeRef; result: TypeRef }
export interface SocketContractEntry { id: string; /** Name the `defineContract` variable is exported under; lets a dependent package resolve a contract it imports */ exportName?: string; commands: Record<string, SocketContractCommand>; events: Record<string, TypeRef>; clientEvents: Record<string, TypeRef>; source: SourceRef }

export interface ConfigModuleEntry { module: string; schemaId: string; defaultsFile?: string; source: SourceRef }
export interface ConfigUsageEntry { path: string; source: SourceRef }   // every @Config('x.y') / config.get('x.y') literal

export interface ModelEntry {
  id: string; className: string; tableName: string; connection?: string;
  columns: { name: string; type: TypeRef; primary: boolean; nullable: boolean }[];  // declared via decorators / class fields only
  relations: { name: string; kind: 'belongsTo' | 'hasMany' | 'hasManyToMany' | 'forwardBelongsTo'; target: string }[];
  accessResource: boolean;
  source: SourceRef;
}
export interface MigrationEntry { id: string; className: string; connection: string; env?: string[]; file: string; mountedBy?: MountedBy; exported?: NotExported; source: SourceRef }
export interface ScheduleEntry { name: string; className: string; options: Record<string, unknown>; mountedBy?: MountedBy; exported?: NotExported; source: SourceRef }
export interface CliCommandEntry { name: string; className: string; description?: string; options: { flags: string; description?: string }[]; arguments: { name: string; description?: string }[]; parent?: string; mountedBy?: MountedBy; source: SourceRef }
export interface QueueMessageEntry { className: string; kind: 'job' | 'event'; payload: TypeRef; options: Record<string, unknown>; source: SourceRef }

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
  configModules: ConfigModuleEntry[]; configUsages: ConfigUsageEntry[];
  models: ModelEntry[]; migrations: MigrationEntry[]; schedules: ScheduleEntry[]; commands: CliCommandEntry[]; queueMessages: QueueMessageEntry[];
  /** Omitted when there are none; only an app built with its dirs has any. */
  scanFiles?: ScanFile[];
  schemas: Record<string, unknown>;   // $id → JSON Schema
  diagnostics: Diagnostic[];
}

export interface Manifest extends Omit<ManifestFragment, 'package'> {
  app: { name: string; version: string; root: string; outDir: string };
  packages: { name: string; version: string; entry: string; outDir: string; fragment: string; configFiles?: string[] }[];
  /** The `APP_ENV` the build read the app's `system.dirs` under. Omitted by a build without configuration. */
  buildEnv?: string;
  generatedAt: string;
  hash: string;                        // sha256 of canonical JSON with `hash` and `generatedAt` blanked
}
