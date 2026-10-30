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
  propertyInjects: { property: string; token: string; optional: boolean; array: boolean; lazy?: boolean; concrete?: boolean; check?: boolean }[];
  /** Imperative DI.resolve(X) calls inside methods; `awaited:false` on an async provider is doctor DI003. */
  imperativeResolves?: { token: string; method: string; awaited: boolean; source: SourceRef }[];
  condition?: Condition;
  source: SourceRef;
}

export interface ValueEntry { token: string; kind: 'value' | 'map'; mapKey?: string; value?: unknown /* literal when known; __http_error_map__: { response: string; status?: number } */; source: SourceRef; condition?: Condition }

export interface TypeRef {
  /** Canonical display name, e.g. 'Promise<Ok<UserDto[]>>' unwrapped to the payload */
  text: string;
  /** `$id` of the derived schema in `schemas`, when derivation succeeded (C1); absent in B-only builds */
  schema?: string;
}

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
  doc?: { summary?: string; description?: string; tags?: string[]; deprecated?: boolean; responses?: { status: number; description?: string; type?: TypeRef }[] };
  source: SourceRef;
}

export interface ControllerEntry {
  id: string; className: string;
  basePath: string | null; basePathConfig?: string;   // as declared; null without @BasePath
  /** Effective base the routes are mounted under (`controllerMountPath`); absent in fragments older than the field. */
  mountPath?: string;
  policies: PolicyRef[][]; middlewares: { type: string; options?: unknown[] }[];
  access?: string[]; allowAnonymous?: boolean;   // class-level @Access / @AllowAnonymous
  routes: RouteEntry[];
  condition?: Condition;
  source: SourceRef;
}

export interface SocketCommandEntry { name: string; handler: string; payload: TypeRef; result: TypeRef; /** The handler returns an async iterable; `result` describes one item */ stream?: true; options: { idempotent?: boolean; ordered?: 'connection' | 'client'; timeoutMs?: number }; access?: string[]; policies: PolicyRef[][]; source: SourceRef }
export interface SocketControllerEntry { id: string; className: string; prefix: string; commands: SocketCommandEntry[]; events: { name: string; payload: TypeRef }[]; source: SourceRef }
export interface SocketContractCommand { payload: TypeRef; result: TypeRef }
export interface SocketContractEntry { id: string; commands: Record<string, SocketContractCommand>; events: Record<string, TypeRef>; clientEvents: Record<string, TypeRef>; source: SourceRef }

export interface ConfigModuleEntry { module: string; schemaId: string; defaultsFile?: string; source: SourceRef }
export interface ConfigUsageEntry { path: string; source: SourceRef }   // every @Config('x.y') / config.get('x.y') literal

export interface ModelEntry {
  id: string; className: string; tableName: string; connection?: string;
  columns: { name: string; type: TypeRef; primary: boolean; nullable: boolean }[];  // declared via decorators / class fields only
  relations: { name: string; kind: 'belongsTo' | 'hasMany' | 'hasManyToMany' | 'forwardBelongsTo'; target: string }[];
  accessResource: boolean;
  source: SourceRef;
}
export interface MigrationEntry { id: string; className: string; connection: string; env?: string[]; file: string; source: SourceRef }
export interface ScheduleEntry { name: string; className: string; options: Record<string, unknown>; source: SourceRef }
export interface CliCommandEntry { name: string; className: string; description?: string; options: { flags: string; description?: string }[]; arguments: { name: string; description?: string }[]; parent?: string; source: SourceRef }
export interface QueueMessageEntry { className: string; kind: 'job' | 'event'; payload: TypeRef; options: Record<string, unknown>; source: SourceRef }

export interface Diagnostic { code: string; severity: 'error' | 'warning' | 'info'; message: string; source?: SourceRef }

export interface ManifestFragment {
  manifestVersion: typeof MANIFEST_VERSION;
  package: { name: string; version: string; entry: string /* relative to package root, e.g. lib/index.js */; outDir: string /* from tsconfig, maps src/x.ts to <outDir>/x.js */ };
  services: ServiceEntry[]; values: ValueEntry[];
  controllers: ControllerEntry[]; socketControllers: SocketControllerEntry[]; socketContracts: SocketContractEntry[];
  configModules: ConfigModuleEntry[]; configUsages: ConfigUsageEntry[];
  models: ModelEntry[]; migrations: MigrationEntry[]; schedules: ScheduleEntry[]; commands: CliCommandEntry[]; queueMessages: QueueMessageEntry[];
  schemas: Record<string, unknown>;   // $id → JSON Schema
  diagnostics: Diagnostic[];
}

export interface Manifest extends Omit<ManifestFragment, 'package'> {
  app: { name: string; version: string; root: string; outDir: string };
  packages: { name: string; version: string; entry: string; outDir: string; fragment: string }[];
  generatedAt: string;
  hash: string;                        // sha256 of canonical JSON with `hash` and `generatedAt` blanked
}
