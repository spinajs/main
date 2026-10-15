import { AuthorizationModel, AuthzAdminBackend, AuthzContributor, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { Assignment, AuthzService } from '@spinajs/authz';
import { AbacContributor, AbacModel, AuthzAbac_2026_10_01_00_00_00, ConfigPolicyStore, DbPolicyStore, PolicyStore } from '@spinajs/authz-abac';
import { AUTHZ_ASSIGNMENT_TABLE, AuthzAdminIdempotency_2026_10_02_00_01_00, AuthzRbac_2026_10_01_00_00_00, DbAuthzAdminBackend, normaliseTags, registerRbac, scopeToColumns, subjectKeyOf, subjectToColumns } from '@spinajs/authz-rbac';
import { hostHarness, testHost } from '@spinajs/authz-testing';
import type { BehaviourHarness, HarnessSession, HostSetup, OrmHandle, OrmModelSpec, OrmQuery, OrmResult, World } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { DeleteQueryBuilder, ModelBase, Orm, createQuery } from '@spinajs/orm';

import { AccessResource, AuthzResourceAncestor_2026_10_14_00_00_00, AuthzScopeAttribute_2026_10_02_00_00_00, Owner, Parent } from '@spinajs/authz-orm';
import { AuthzAudit_2026_10_01_00_00_00 } from '@spinajs/authz-orm/audit';
import { TestDb } from './db.js';
import type { Dialect } from './db.js';
// authz-rbac's test database helpers import only libraries.
import { createPgDatabase, dropPgDatabase, requirePostgres } from '../../../../authz-rbac/test/support/db.js';

export const E2E_DIALECTS: readonly Dialect[] = ['sqlite', 'postgres'];

export async function withPostgres(ctx: Mocha.Context, kind: Dialect): Promise<void> {
  if (kind === 'postgres') await requirePostgres(ctx);
}

const LINK_SECRET = 'authz-orm-e2e-link-secret-of-at-least-32-chars';
const ADMIN_PERMISSIONS = ['authz:assignments.manage', 'authz:links.manage', 'authz:rules.manage', 'authz:policies.manage', 'authz:scope.manage', 'authz:scope.forget'];
const GUARD = { service: 'DefaultAdminGuard', privilegedPermission: 'authz:assignments.manage', protectSystemRole: true, preventEscalation: true, preventSelfLockout: true, preventLastPrivilegedRemoval: true };
// Children first, so a DELETE never trips a foreign key.
const AUTHZ_TABLES = ['authz_rule_subject', 'authz_rule', 'authz_link', 'authz_subject_membership', 'authz_assignment', 'authz_policy', 'authz_scope_attribute', 'authz_resource_ancestor', 'authz_admin_idempotency', 'authz_version'];

type ModelClass = typeof ModelBase & (new () => ModelBase);
const pk = (row: unknown): string => String((row as { id: unknown }).id);

let activeDb: TestDb | undefined;

/** DbAuthzAdminBackend over the DI root, where TestDb's Orm lives. */
export class E2eAdminBackend extends DbAuthzAdminBackend {
  constructor() {
    super({ container: DI.RootContainer });
  }
}

/** The `orm` lane of authz-testing (L5) over TestDb: one class per spec per case, rows inserted through the ORM as SYSTEM. */
export class E2eOrm implements OrmHandle {
  private models = new Map<string, ModelClass>();

  constructor(
    private readonly db: TestDb,
    private readonly kind: Dialect,
  ) {}

  model(name: string): ModelClass {
    const m = this.models.get(name);
    if (!m) throw new Error(`e2e: no model ${name} in this case`);
    return m;
  }

  async use(specs: readonly OrmModelSpec[]): Promise<void> {
    await this.db.clear();
    this.models = new Map();
    for (const s of specs) {
      const cls = await this.db.define(
        {
          name: s.name,
          columns: Object.fromEntries(s.columns.map((c) => [c, 'TEXT'])),
          decorate: (model, proto) => {
            if (s.type === undefined) return;
            AccessResource(s.type)(model);
            if (s.owner !== undefined) Owner()(proto, s.owner);
            for (const p of s.parents ?? []) Parent(p.type, p.nullable ? { nullable: true } : undefined)(proto, p.column);
          },
        },
        this.kind,
      );
      this.models.set(s.name, cls);
    }
    for (const s of specs) {
      for (const row of s.rows ?? []) await runWithPrincipal(SYSTEM, async () => void (await (this.model(s.name) as unknown as { insert(r: unknown): Promise<unknown> }).insert(row)));
    }
  }

  async run(q: OrmQuery): Promise<OrmResult> {
    const M = this.model(q.model) as unknown as { query(): any; insert(v: unknown): any; update(v: unknown): any };
    const where = (b: any, w: Readonly<Record<string, unknown>> | undefined) => Object.entries(w ?? {}).reduce((acc, [k, v]) => acc.where(k, v), b);
    switch (q.op) {
      case 'select': {
        let b = where(M.query(), q.where);
        if (q.accessible) b = b.accessible(q.accessible);
        if (q.withAccess) b = b.withAccess(q.withAccess);
        const rows = (await b) as Record<string, unknown>[];
        const access = q.withAccess ? Object.fromEntries(rows.map((r) => [pk(r), r['$access'] as Record<string, boolean>])) : undefined;
        return { ids: rows.map(pk), count: rows.length, sql: [], ...(access ? { access } : {}) };
      }
      case 'insert':
        await M.insert(q.values);
        return { sql: [] };
      case 'update': {
        let b = where(M.update(q.values), q.where);
        if (q.accessible) b = b.accessible(q.accessible);
        const r = (await b) as { RowsAffected?: number } | undefined;
        return { count: r?.RowsAffected, sql: [] };
      }
      case 'delete': {
        // ModelBase.destroy() refuses a delete without primary keys, so a bulk delete starts from the builder.
        let b = where(createQuery(M as unknown as ModelClass, DeleteQueryBuilder).query, q.where);
        if (q.accessible) b = b.accessible(q.accessible);
        const r = (await b) as { RowsAffected?: number } | undefined;
        return { count: r?.RowsAffected, sql: [] };
      }
    }
  }

  async rows(model: string): Promise<readonly Readonly<Record<string, unknown>>[]> {
    return this.db.rows(this.model(model));
  }
}

const roleConfig = (roles: readonly { name: string; source?: string }[]): Record<string, unknown> => Object.fromEntries(roles.map(({ name, source: _source, ...def }) => [name, def]));

/** A world assignment as a row; raw, so an expiry in the past is kept (AuthzAdmin refuses one). */
export async function insertAssignment(db: TestDb, kind: Dialect, a: Assignment): Promise<void> {
  await db
    .driver(kind)
    .insert()
    .into(AUTHZ_ASSIGNMENT_TABLE)
    .values({ id: a.id, ...subjectToColumns(a.subject), subject_key: subjectKeyOf(a.subject), role: a.role, ...scopeToColumns(a.scope), tags: normaliseTags(a.tags), expires_at: a.expiresAt ?? null, granted_by: null, source: a.source ?? 'db', created_at: new Date() });
}

export interface E2eHarness extends BehaviourHarness {
  db(): TestDb;
  model(name: string): ModelClass;
}

/**
 * hostHarness over TestDb (`kind`): the real authz migrations, the world's ORM models, RBAC from `world.rbac` (roles in
 * config, assignments as rows, `registerRbac`), ABAC from `world.abac` (config policies plus a DbPolicyStore that
 * AuthzAdmin writes), the DB admin backend, and the app env `test` (the runtime guard throws).
 */
export function e2eHarness(kind: Dialect): E2eHarness {
  let db: TestDb | undefined;
  let database: string | undefined;
  let lane: E2eOrm | undefined;
  const need = <T>(v: T | undefined, what: string): T => v ?? (() => { throw new Error(`e2eHarness: ${what} (beforeAll did not run)`); })();

  const base = hostHarness({
    facets: ['rbac', 'abac', 'orm', 'admin', 'store', 'list'],
    async register(host: HostSetup) {
      const test = need(db, 'no database');
      const orm = need(lane, 'no orm lane');
      const world: World = host.world;
      const c = host.container;
      for (const t of AUTHZ_TABLES) await test.raw(`DELETE FROM ${t}`, [], kind);

      host.setConfig(['process', 'env', 'APP_ENV'], 'test');
      host.setConfig(['authz', 'orm', 'domain'], host.domain);
      c.register(testHost.instance(test.orm)).as(Orm);
      host.setConfig(['authz', 'rbac', 'stores'], { roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'], links: ['DbLinkStore'] });
      host.setConfig(['authz', 'rbac', 'connection'], kind);
      host.setConfig(['authz', 'rbac', 'links', 'secret'], LINK_SECRET);
      host.setConfig(['authz', 'rbac', 'roles'], roleConfig((world.rbac?.roles ?? []) as readonly { name: string; source?: string }[]));
      host.setConfig(['authz', 'admin'], { connection: kind, backend: 'E2eAdminBackend', guard: GUARD });
      const declared = new Set(world.permissions.map((p) => (typeof p === 'string' ? p : p.name)));
      for (const p of ADMIN_PERMISSIONS) if (!declared.has(p)) host.setConfig(['authz', 'domains', host.domain, 'permissions', p], {});
      c.register(E2eAdminBackend).as(AuthzAdminBackend);

      await orm.use(world.lane?.orm?.models ?? []);

      if (world.rbac) {
        await registerRbac(c, (await c.resolve(Configuration)) as Configuration, { clock: host.kit.clock });
        for (const a of world.rbac.assignments ?? []) await insertAssignment(test, kind, a);
      }
      if (world.abac) {
        const written = new DbPolicyStore(() => test.driver(kind));
        const abac = new AbacModel({ stores: [new ConfigPolicyStore(world.abac.policies), written] });
        c.register(testHost.instance(abac)).as(AuthorizationModel);
        c.register(testHost.instance(new AbacContributor(abac))).as(AuthzContributor);
        c.register(testHost.instance(written)).as(PolicyStore);
      }
    },
    extend(_host: HostSetup, session: HarnessSession) {
      return { admin: (session.authz as unknown as AuthzService).admin(), lane: { orm: need(lane, 'no orm lane') } } as Partial<HarnessSession>;
    },
  });

  async function afterAll(): Promise<void> {
    try {
      await base.afterAll?.();
    } finally {
      const open = db;
      db = undefined;
      lane = undefined;
      activeDb = undefined;
      try {
        await open?.close();
      } finally {
        if (database) await dropPgDatabase(database);
        database = undefined;
      }
    }
  }

  return {
    ...base,
    db: () => need(db, 'no database'),
    model: (name) => need(lane, 'no orm lane').model(name),
    async beforeAll() {
      try {
        if (kind === 'postgres') database = await createPgDatabase('authz_orm_e2e');
        db = await TestDb.open({ postgres: kind === 'postgres', ...(database ? { database } : {}) });
        activeDb = db;
        const driver = db.driver(kind);
        for (const m of [new AuthzRbac_2026_10_01_00_00_00(), new AuthzAdminIdempotency_2026_10_02_00_01_00(), new AuthzAbac_2026_10_01_00_00_00(), new AuthzScopeAttribute_2026_10_02_00_00_00(), new AuthzAudit_2026_10_01_00_00_00(), new AuthzResourceAncestor_2026_10_14_00_00_00()]) await m.up(driver);
        lane = new E2eOrm(db, kind);
        await base.beforeAll?.();
      } catch (e) {
        await afterAll();
        throw e;
      }
    },
    afterAll,
  };
}

/** The database of the running e2e harness, for raw assertions. */
export function e2eDb(): TestDb {
  if (!activeDb) throw new Error('e2e: no database is open');
  return activeDb;
}
