import { AccessDenied, SYSTEM, resourceKey, runWithPrincipal } from '@spinajs/authz';
import type { AuthzService, Permission, Principal, ResourceFilter, ResourceRef, ResourceType } from '@spinajs/authz';
import { AccessResource, AuthzScopeAttribute_2026_10_02_00_00_00, DbScopeAttributeStore, ScopeColumn } from '@spinajs/authz-orm';
import { AuthzAdminIdempotency_2026_10_02_00_01_00, AuthzRbac_2026_10_01_00_00_00, DbAuthzAdminBackend, RbacModelRoleGraphSource, RbacRoleGraphSource, RbacScopeAttributeSource, RbacScopeDefaults, createRbacExtensions, ormRbacScopeLayers, rbacAssignmentExtension, registerRbac } from '@spinajs/authz-rbac';
import type { RbacModel } from '@spinajs/authz-rbac';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Connection, Model, ModelBase, Orm, Primary } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

// Not root exports of authz-orm; the build @spinajs/authz-orm resolves to, so one copy of the module.
import { OrmResourceAdapter } from '../../../authz-orm/lib/mjs/adapter.js';
import { compileResidual } from '../../../authz-orm/lib/mjs/compile/compiler.js';
import { relationPrincipalOf } from '../../../authz-orm/lib/mjs/principal.js';
import { unregisterResource } from '../../../authz-orm/lib/mjs/registry.js';
// authz-rbac's test database helpers import only libraries, never the kit.
import { PG_SERVER, createPgDatabase, dropPgDatabase, requirePostgres } from '../../../authz-rbac/test/support/db.js';
import { testHost } from '../../src/index.js';
import type { BehaviourHarness, HarnessSession, World } from '../../src/index.js';
import { clearCanvasTables, rawQuery } from './db.js';
import { loadCanvasFixtures } from './fixtures.js';
import type { CanvasFixtures } from './fixtures.js';
import { CANVAS_DB_FACETS, assertCaseRoleStore, canvasHostHarness, canvasWorld } from './harness.js';
import { CanvasScopeResolver, ORG_ATTRIBUTE_SCHEMA, branchRef, parseBranchId } from './scope.js';

export { requirePostgres };

export type CanvasSqlKind = 'sqlite' | 'postgres';

/** The root Orm's one connection per dialect: the list models, the authz tables and the stores. */
const CANVAS_SQL_CONNECTIONS: Readonly<Record<CanvasSqlKind, string>> = Object.freeze({ sqlite: 'k1b-canvas-sqlite', postgres: 'k1b-canvas-pg' });

const CANVAS_SQL_DOMAIN = 'k1bcanvas';

/** Every canvas model is read with `project:read` (C6 `project.read`; the config has no `<type>:read`). */
const CANVAS_READ: Permission = 'project:read';

export const CANVAS_SQL_TYPES = ['org', 'project', 'file', 'branch'] as const satisfies readonly ResourceType[];
export type CanvasSqlType = (typeof CANVAS_SQL_TYPES)[number];

/** Each type's `@ScopeColumn`s, nearest ancestor first (authz-orm reads them in declaration order). */
const SCOPES: Readonly<Record<CanvasSqlType, readonly ResourceType[]>> = Object.freeze({ org: [], project: ['org'], file: ['project', 'org'], branch: ['file', 'project', 'org'] });

export type CanvasRow = Readonly<Record<string, string | null>> & { readonly id: string };
export type CanvasRows = Readonly<Record<CanvasSqlType, readonly CanvasRow[]>>;

type ModelClass = typeof ModelBase & (new () => ModelBase);

/** A branch name the pattern matches: each run of `*` becomes 'x'. */
const sampleName = (pattern: string): string => pattern.replace(/\*+/g, 'x');

/**
 * The model rows of the state: every org, project and file, and the branches the cases name, `main` on every file in
 * its own project (so branch lists span projects and orgs) and, for each file of a project with branch rules, one
 * sample name per rule pattern. A branch CanvasScopeResolver answers null for (its file lies in another project) gets
 * no row: authz-orm's adapter then answers null too, as the resolver does.
 */
export function canvasRows(fixtures: Pick<CanvasFixtures, 'state' | 'cases'>): CanvasRows {
  const { state } = fixtures;
  const orgOf = (project: string): string | undefined => state.projects.get(project)?.org;
  const branches = new Map<string, CanvasRow>();
  const addBranch = (project: string, file: string | null, name: string) => {
    if (file !== null && state.files.get(file)?.project !== project) return;
    const org = orgOf(project);
    if (org === undefined || !state.orgs.has(org)) return;
    const id = branchRef(project, file, name).id as string;
    branches.set(id, { id, name, file_id: file, project_id: project, org_id: org });
  };
  for (const c of fixtures.cases) if (c.resource.kind === 'branch') addBranch(c.resource.project, c.resource.file, c.resource.branch);
  for (const [file, f] of state.files) addBranch(f.project, file, 'main');
  for (const [project, p] of state.projects) {
    for (const [file, f] of state.files) if (f.project === project) for (const rule of p.branch_rules) addBranch(project, file, sampleName(rule.pattern));
  }
  return {
    org: [...state.orgs.keys()].map((id) => ({ id })),
    project: [...state.projects].map(([id, p]) => ({ id, org_id: p.org })),
    file: [...state.files].map(([id, f]) => ({ id, project_id: f.project, org_id: orgOf(f.project) ?? null })),
    branch: [...branches.values()],
  };
}

/** A row id as fixture symbols: `WEB/HOME:main` for a branch. */
export function rowLabel(fixtures: Pick<CanvasFixtures, 'symbolOf'>, type: ResourceType, id: string): string {
  if (type !== 'branch') return fixtures.symbolOf(id);
  const b = parseBranchId(id);
  return b ? `${fixtures.symbolOf(b.project)}/${b.file === null ? '-' : fixtures.symbolOf(b.file)}:${b.name}` : id;
}

/** The drivers register under their names at import, but a suite that unregisters a driver class leaves the name empty. */
function ensureDriver(name: string, driver: Class<unknown>): () => void {
  if ((DI.RootContainer.Registry.getTypes(name, false) ?? []).length > 0) return () => undefined;
  DI.register(driver).as(name);
  return () => {
    const list = DI.RootContainer.Registry.getTypes(name, false) ?? [];
    const i = list.indexOf(driver);
    if (i >= 0) list.splice(i, 1);
  };
}

let seq = 0;

/**
 * An Orm in the DI root, as authz-orm's adapter, middleware and compilers read it, with one connection: SQLite
 * `:memory:` or a Postgres database of its own (jit off). It holds the authz tables (the real migrations) and the
 * canvas models. A trimmed copy of authz-rbac's RootOrm, which imports the built kit (a second testHost).
 * It leaves out RootOrm's Array.ofType swap: no authz-testing suite loads a second @spinajs/di copy; if Array.ofType
 * lists (authz-orm's native compilers, the orm's hydrators) resolve empty, that swap is the fix.
 */
class CanvasRootDb {
  private readonly models: { model: ModelClass; table: string }[] = [];

  private constructor(readonly kind: CanvasSqlKind, readonly orm: Orm, private readonly undo: () => Promise<void>) {}

  static async open(kind: CanvasSqlKind): Promise<CanvasRootDb> {
    if (DI.RootContainer.Cache.has(Orm)) throw new Error('canvasSqlHarness: the DI root already holds an Orm');
    let ownsInstall = false;
    try {
      testHost.config();
    } catch {
      await testHost.installHost();
      ownsInstall = true;
    }
    const cfg = testHost.config();
    const before = { logger: cfg.get<unknown>('logger'), db: cfg.get<unknown>('db') };
    const name = CANVAS_SQL_CONNECTIONS[kind];
    const drivers = [ensureDriver('orm-driver-sqlite', SqliteOrmDriver), ensureDriver('orm-driver-postgres', PostgresOrmDriver)];
    let database: string | undefined;
    const restore = async () => {
      for (const undo of drivers) undo();
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) cfg.unset(k);
        else cfg.set(k, v);
      }
      try {
        if (database) await dropPgDatabase(database);
      } finally {
        if (ownsInstall) await testHost.uninstallHost();
      }
    };
    let orm: Orm;
    try {
      if (kind === 'postgres') database = await createPgDatabase('k1b_canvas');
      const connection = kind === 'postgres' ? { Driver: 'orm-driver-postgres', Name: name, ...PG_SERVER, Database: database } : { Driver: 'orm-driver-sqlite', Name: name, Filename: ':memory:' };
      cfg.set('logger', { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] });
      cfg.set('db', { DefaultConnection: name, Connections: [connection] });
      DI.setESMModuleSupport();
      orm = (await DI.resolve(Orm)) as Orm;
    } catch (e) {
      DI.RootContainer.uncache(Orm);
      await restore();
      throw e;
    }
    const db = new CanvasRootDb(kind, orm, async () => {
      DI.RootContainer.uncache(Orm);
      try {
        await orm.dispose();
      } finally {
        await restore();
      }
    });
    try {
      await new AuthzRbac_2026_10_01_00_00_00().up(db.driver);
      await new AuthzAdminIdempotency_2026_10_02_00_01_00().up(db.driver);
      await new AuthzScopeAttribute_2026_10_02_00_00_00().up(db.driver);
      if (kind === 'postgres') await db.withoutJit();
    } catch (e) {
      await db.close();
      throw e;
    }
    return db;
  }

  get driver(): OrmDriver {
    const d = this.orm.Connections.get(CANVAS_SQL_CONNECTIONS[this.kind]);
    if (!d) throw new Error(`canvasSqlHarness: no ${this.kind} connection`);
    return d;
  }

  raw(sql: string, bindings: unknown[] = []): Promise<any> {
    return rawQuery(this.driver, sql, bindings);
  }

  /** route-world's withoutJit: new sessions of the database start with jit off, the open ones are ended. */
  private async withoutJit(): Promise<void> {
    await this.raw(`DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET jit = off', current_database()); END $$`);
    await this.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()');
    await this.raw('SET jit = off');
  }

  /** Defines a model on the connection, creates its table and inserts the rows past every query middleware. */
  async define(spec: { name: string; columns: Readonly<Record<string, string>>; rows: readonly CanvasRow[]; decorate(model: ModelClass, proto: object): void }): Promise<ModelClass> {
    const name = `${spec.name}_${process.pid}_${++seq}`;
    const table = name.toLowerCase();
    const cls = { [name]: class extends ModelBase {} }[name] as ModelClass;
    Primary()(cls.prototype, 'id');
    spec.decorate(cls, cls.prototype);
    Connection(CANVAS_SQL_CONNECTIONS[this.kind])(cls);
    Model(table)(cls);
    const ddl = Object.entries(spec.columns).map(([c, t]) => `"${c}" ${t}${c === 'id' ? ' PRIMARY KEY' : ''}`);
    await this.raw(`CREATE TABLE "${table}" (${ddl.join(', ')})`);
    this.models.push({ model: cls, table });

    const orm = this.orm as unknown as { registerModel(m: unknown): void; applyModelMixins(): void; wireRelations(): void };
    orm.registerModel(cls);
    orm.wireRelations();
    orm.applyModelMixins();
    await this.orm.reloadTableInfo();
    for (const row of spec.rows) {
      const keys = Object.keys(row);
      const marks = this.kind === 'postgres' ? keys.map((_, i) => `$${i + 1}`) : keys.map(() => '?');
      await this.raw(`INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${marks.join(', ')})`, keys.map((k) => row[k]));
    }
    return cls;
  }

  /** Drops the tables and forgets the classes (the orm's model list, DI, authz-orm's registry), then the Orm. */
  async close(): Promise<void> {
    try {
      const ormModels = this.orm.Models as { type: unknown }[];
      for (const m of this.models.splice(0).reverse()) {
        await this.raw(`DROP TABLE IF EXISTS "${m.table}"`);
        const i = ormModels.findIndex((x) => x.type === m.model);
        if (i >= 0) ormModels.splice(i, 1);
        DI.RootContainer.Registry.unregister(m.model);
        unregisterResource(m.model);
      }
    } finally {
      await this.undo();
    }
  }
}

async function defineCanvasModels(db: CanvasRootDb, rows: CanvasRows): Promise<Map<ResourceType, ModelClass>> {
  const out = new Map<ResourceType, ModelClass>();
  for (const type of CANVAS_SQL_TYPES) {
    const scopes = SCOPES[type];
    const columns: Record<string, string> = { id: 'TEXT' };
    // The branch rules' `resource.name`: SQL reads the column, check reads the adapter's scope attribute.
    if (type === 'branch') columns.name = 'TEXT';
    for (const s of scopes) columns[`${s}_id`] = 'TEXT';
    const model = await db.define({
      name: `Canvas_${type}`,
      columns,
      rows: rows[type],
      decorate: (cls, proto) => {
        AccessResource(type, { permissions: { read: CANVAS_READ }, ...(type === 'branch' ? { attributes: ['name'] } : {}) })(cls);
        for (const s of scopes) ScopeColumn(`${s}_id`, s)(proto, `${s}_id`);
      },
    });
    out.set(type, model);
  }
  return out;
}

const refsText = (refs: readonly ResourceRef[] | null): string => (refs === null ? 'null (no row)' : refs.map((r) => JSON.stringify([r.type, r.id ?? null])).join(' → '));

/**
 * Asserts that authz-orm's adapter gives every model row the ancestors and scope attributes CanvasScopeResolver gives
 * it, and null, as the resolver, for each case resource without a row.
 * @returns how many rows and row-less case resources it compared
 */
export async function assertMirroredRows(fixtures: CanvasFixtures, rows: CanvasRows): Promise<{ rows: number; rowless: number }> {
  const orm = new OrmResourceAdapter();
  const resolver = new CanvasScopeResolver(fixtures.state);
  const sys = <T>(fn: () => Promise<T>): Promise<T> => runWithPrincipal(SYSTEM, fn);
  const differ = async (ref: ResourceRef): Promise<string | undefined> => {
    const got = refsText(await sys(() => orm.ancestors(ref)));
    const want = refsText(await resolver.ancestors(ref));
    if (got !== want) return `authz-orm gives ${resourceKey(ref)} the ancestors ${got}, CanvasScopeResolver ${want}`;
    const gotAttrs = JSON.stringify(await sys(() => orm.scopeAttributes(ref)));
    const wantAttrs = JSON.stringify(await resolver.attributes(ref));
    if (gotAttrs !== wantAttrs) return `authz-orm gives ${resourceKey(ref)} the attributes ${gotAttrs}, CanvasScopeResolver ${wantAttrs}`;
    return undefined;
  };
  const problems: string[] = [];
  let count = 0;
  const known = new Set<string>();
  for (const type of CANVAS_SQL_TYPES) {
    for (const row of rows[type]) {
      const ref = { type, id: row.id };
      known.add(resourceKey(ref));
      count++;
      const p = await differ(ref);
      if (p) problems.push(p);
    }
  }
  const rowless = new Map<string, ResourceRef>();
  for (const c of fixtures.cases) {
    const r = c.resource;
    const ref: ResourceRef = r.kind === 'branch' ? branchRef(r.project, r.file, r.branch) : { type: r.kind, id: r.kind === 'org' ? r.org : r.kind === 'project' ? r.project : r.file };
    if (!known.has(resourceKey(ref))) rowless.set(resourceKey(ref), ref);
  }
  for (const ref of rowless.values()) {
    const p = await differ(ref);
    if (p) problems.push(p);
  }
  if (problems.length > 0) throw new Error(`canvasSqlHarness: the SQL world and the check world disagree on the tree:\n${problems.join('\n')}`);
  return { rows: count, rowless: rowless.size };
}

/** One list: the compiled residual run as SQL, and the same through authz-orm's middleware for the read permission. */
export interface SqlList {
  readonly residual: ResourceFilter;
  /** The ids the statement returned, in its order. */
  readonly ids: readonly string[];
  /** The statements the list ran (none for a FALSE residual). */
  readonly statements: readonly string[];
  /** Rows the one statement returned. */
  readonly returned?: number;
  /** `CANVAS_READ` only: the ids an app's plain `Model.query()` lists as the principal. */
  readonly viaMiddleware?: readonly string[];
  /** Time of filter, compile and statement. */
  readonly ms: number;
}

/** The SQL lane handle (`session.lane.canvasSql`). */
export interface CanvasSqlHandle {
  readonly kind: CanvasSqlKind;
  readonly rows: CanvasRows;
  readonly driver: OrmDriver;
  list(principal: Principal, permission: Permission, type: CanvasSqlType): Promise<SqlList>;
  /** The model row of `ref` (loaded as SYSTEM), null when it has none. */
  load(ref: ResourceRef): Promise<unknown>;
}

declare module '../../src/behaviour/harness.js' {
  interface LaneHandles {
    canvasSql: CanvasSqlHandle;
  }
}

/** kit-harness's countStatements, copied: that module imports the built kit (a second testHost). */
async function countStatements<T>(driver: OrmDriver, fn: () => Promise<T>): Promise<{ value: T; statements: { sql: string; result: unknown }[] }> {
  const d = driver as unknown as { executeOnDb(sql: string, bindings: unknown[], context: unknown): Promise<unknown> };
  const own = Object.prototype.hasOwnProperty.call(d, 'executeOnDb');
  const before = d.executeOnDb;
  const statements: { sql: string; result: unknown }[] = [];
  d.executeOnDb = async function (this: unknown, sql: string, bindings: unknown[], context: unknown) {
    const result = await before.call(this, sql, bindings, context);
    statements.push({ sql, result });
    return result;
  };
  try {
    return { value: await fn(), statements };
  } finally {
    if (own) d.executeOnDb = before;
    else delete (d as Partial<typeof d>).executeOnDb;
  }
}

const idsOf = (rows: unknown): string[] => (rows as ModelBase[]).map((r) => String((r as unknown as { id: unknown }).id));

/** The case's RbacModel serves authz-orm's compilers (resolved in root) for the canvas models only. */
class CanvasGraphSource extends RbacRoleGraphSource {
  constructor(private readonly source: () => RbacModelRoleGraphSource | undefined) {
    super();
  }

  graph(model: Class<ModelBase>) {
    return this.source()?.graph(model);
  }

  listing(model: Class<ModelBase>) {
    return this.source()?.listing(model);
  }
}

class CanvasAttributeSource extends RbacScopeAttributeSource {
  constructor(private readonly models: () => ReadonlySet<unknown>) {
    super();
  }

  defaults(model: Class<ModelBase>, driver: OrmDriver): RbacScopeDefaults | undefined {
    return this.models().has(model) ? RbacScopeDefaults.of([ORG_ATTRIBUTE_SCHEMA], ormRbacScopeLayers(driver)) : undefined;
  }
}

/** DbAuthzAdminBackend over the root container: the test host's configuration and the root Orm. */
class CanvasRootAdminBackend extends DbAuthzAdminBackend {
  constructor() {
    super({ container: DI.RootContainer });
  }
}

/** canvasWorld('sqlite') with the admin section on the root Orm's connection; the stores follow authz.admin.connection. */
export function canvasSqlWorld(kind: CanvasSqlKind): World {
  const world = canvasWorld('sqlite');
  const config = world.config!;
  return {
    ...world,
    config: {
      ...config,
      // A check reads the DB stores per row; on a loaded machine the 2 s default turns a slow check into
      // model_error, a refusal the list does not share.
      engine: { modelTimeoutMs: 120000 },
      admin: { ...(config.admin as Record<string, unknown>), connection: CANVAS_SQL_CONNECTIONS[kind], backend: CanvasRootAdminBackend.name },
    },
  };
}

/** `SHOW jit` on the session's connection (Postgres). */
export async function jitSetting(session: HarnessSession): Promise<string> {
  const driver = session.lane?.canvasSql?.driver;
  if (!driver) throw new Error('jitSetting: the session has no canvasSql lane handle');
  return ((await rawQuery(driver, 'SHOW jit')) as { jit: string }[])[0].jit;
}

/**
 * The canvas harness over the §8.5 DB stores on the DI root's Orm (`kind`), with the canvas types as authz-orm models
 * on the same connection, the RBAC list extension with rules, and the lane handle `canvasSql` that lists a type with
 * authz-orm's compiler as one SQL statement. beforeAll boots the database, defines the models and asserts that
 * authz-orm and CanvasScopeResolver agree on every row; each case clears the authz tables and loads the state
 * through AuthzAdmin. Postgres: call `requirePostgres` before beforeAll.
 */
export function canvasSqlHarness(kind: CanvasSqlKind): BehaviourHarness {
  const fixtures = loadCanvasFixtures();
  const rows = canvasRows(fixtures);
  let db: CanvasRootDb | undefined;
  let models = new Map<ResourceType, ModelClass>();
  let served: ReadonlySet<unknown> = new Set();
  let rbac: RbacModel | undefined;
  let undo: (() => void)[] = [];

  const modelOf = (type: ResourceType): ModelClass => {
    const m = models.get(type);
    if (!m) throw new Error(`canvasSqlHarness: no model of type '${type}'`);
    return m;
  };

  async function list(session: HarnessSession, principal: Principal, permission: Permission, type: CanvasSqlType): Promise<SqlList> {
    const started = Date.now();
    const authz = session.authz as unknown as AuthzService;
    const residual = await authz.filter(principal, permission, type);
    // Under inherit the residual reads principal.* from the delegate, as authz-orm's middleware compiles it.
    const compileFor = relationPrincipalOf(principal, authz);
    const Model = modelOf(type) as unknown as { query(): any };
    let ids: string[] = [];
    let statements: { sql: string; result: unknown }[] = [];
    if (residual.op !== 'false') {
      const run = await countStatements(db!.driver, () =>
        runWithPrincipal(SYSTEM, async () => {
          const q = Model.query();
          compileResidual(residual, q, { model: modelOf(type), principal: compileFor, op: 'read' });
          return idsOf(await q);
        }),
      );
      ids = run.value;
      statements = run.statements;
    }
    const returned = statements.length === 1 && Array.isArray(statements[0].result) ? (statements[0].result as unknown[]).length : undefined;
    const out = { residual, ids, statements: statements.map((s) => s.sql), ...(returned === undefined ? {} : { returned }), ms: Date.now() - started };
    if (permission !== CANVAS_READ) return out;
    let viaMiddleware: string[];
    try {
      viaMiddleware = idsOf(await runWithPrincipal(principal, async () => Model.query()));
    } catch (e) {
      // authz-orm refuses a FALSE residual before SQL (H16).
      if (!(e instanceof AccessDenied && residual.op === 'false')) throw e;
      viaMiddleware = [];
    }
    return { ...out, viaMiddleware };
  }

  const adapter = new OrmResourceAdapter();
  const load = (ref: ResourceRef): Promise<unknown> => runWithPrincipal(SYSTEM, async () => adapter.load(ref));

  const base = canvasHostHarness({
    domain: CANVAS_SQL_DOMAIN,
    facets: [...CANVAS_DB_FACETS, 'list'],
    backend: CanvasRootAdminBackend,
    async rbac(host, configuration) {
      if (!db) throw new Error('canvasSqlHarness: the database is not booted (beforeAll did not run)');
      const c = host.container;
      host.setConfig(['authz', 'orm', 'domain'], CANVAS_SQL_DOMAIN);
      await clearCanvasTables(db.driver);
      c.register(testHost.instance(db.orm)).as(Orm);
      const wired = await registerRbac(c, configuration, { extensions: (o) => [...createRbacExtensions(o), rbacAssignmentExtension(o, { rules: true })], clock: host.kit.clock });
      await assertCaseRoleStore(c, configuration);
      rbac = wired.model;
      return { service: wired.service, attributes: new DbScopeAttributeStore({ connection: CANVAS_SQL_CONNECTIONS[kind] }) };
    },
    driver: () => db?.driver,
    subject: load,
    extend(_host, session) {
      const handle: CanvasSqlHandle = { kind, rows, driver: db!.driver, list: (principal, permission, type) => list(session, principal, permission, type), load };
      return {
        list: async (principal, permission, type) => (await list(session, principal, permission, type as CanvasSqlType)).ids,
        lane: { canvasSql: handle },
      };
    },
  });

  async function afterAll(): Promise<void> {
    try {
      await base.afterAll?.();
    } finally {
      for (const u of undo.splice(0)) u();
      DI.uncache(RbacRoleGraphSource);
      DI.uncache(RbacScopeAttributeSource);
      rbac = undefined;
      models = new Map();
      served = new Set();
      const open = db;
      db = undefined;
      await open?.close();
    }
  }

  return {
    ...base,
    async beforeAll() {
      db = await CanvasRootDb.open(kind);
      try {
        models = await defineCanvasModels(db, rows);
        served = new Set(models.values());
        await assertMirroredRows(fixtures, rows);
        undo = [
          testHost.registerInRoot(RbacRoleGraphSource, testHost.instance(new CanvasGraphSource(() => (rbac ? new RbacModelRoleGraphSource(rbac, (m) => served.has(m)) : undefined)))),
          testHost.registerInRoot(RbacScopeAttributeSource, testHost.instance(new CanvasAttributeSource(() => served))),
        ];
        await base.beforeAll?.();
      } catch (e) {
        await afterAll();
        throw e;
      }
    },
    afterAll,
  };
}
