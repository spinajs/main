import { AuthorizationModel, AuthzAdminBackend, AuthzContributor, AuthzEventSink, MemoryScopeAttributeStore, ScopeAttributeStore, WritableScopeAttributeStore, principalKey } from '@spinajs/authz';
import type { Assignment, AuthzService, Permission, Principal, ResourceType } from '@spinajs/authz';
import { evaluateFilter, hostHarness, testHost } from '@spinajs/authz-testing';
import type { BehaviourHarness, Facet, HarnessSession, HostSetup, WorldLink } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { Orm, QueryContext } from '@spinajs/orm';

import adminConfig from '../../src/config/admin.js';
import { AUTHZ_ASSIGNMENT_TABLE, AUTHZ_LINK_TABLE, AUTHZ_RULE_SUBJECT_TABLE, AUTHZ_RULE_TABLE, AUTHZ_VERSION_TABLE, AdminAssignmentStore, AdminLinkStore, AdminRuleStore, DbAuthzAdminBackend, RbacContributor, RbacModel, RbacService, RoleStore, linkTokenHash, normaliseTags, readVersion, registerRbacStores, scopeToColumns, subjectToColumns } from '../../src/index.js';
import type { ConfigRoleStore, DbAssignmentStore, DbLinkStore, DbRuleStore } from '../../src/index.js';
import type { LadderDef, RbacExtension, RbacModelOptions, RoleDef } from '../../src/index.js';
import { RecordingEventSink } from '../admin/admin-harness.js';
import { TestRbacModel } from '../admin/test-rbac-model.js';
import { rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';

const { instance } = testHost;

/** `authz.rbac.links.secret` for the cases that create links. */
export const LINK_SECRET = 'l2-task-10-link-secret-of-at-least-32-chars';

/** `authz.rbac.stores` of every case: the DB stores (the default rule store, ConfigRuleStore, is L1b's). */
const HARNESS_STORES = { roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'], rules: ['DbRuleStore'], links: ['DbLinkStore'] };

const ADMIN_PERMISSIONS = ['authz:assignments.manage', 'authz:links.manage', 'authz:rules.manage'];

const CLEARED = [AUTHZ_RULE_SUBJECT_TABLE, AUTHZ_RULE_TABLE, AUTHZ_LINK_TABLE, AUTHZ_ASSIGNMENT_TABLE, AUTHZ_VERSION_TABLE, 'authz_admin_idempotency'];

/** A world RoleDef as `authz.rbac.roles.<name>`, so ConfigRoleStore reads it back. */
export function roleConfig(roles: readonly RoleDef[]): Record<string, unknown> {
  return Object.fromEntries(roles.map(({ name, source: _source, ...def }) => [name, def]));
}

export function ladderConfig(ladders: readonly LadderDef[]): Record<string, unknown> {
  return Object.fromEntries(ladders.map(({ name, ...def }) => [name, def]));
}

/** The `authz_assignment` row of `a`, with its own id (lane handle rbacStore.insertAssignment). */
export async function insertAssignment(db: TestDb, a: Assignment, createdAt = new Date()): Promise<void> {
  await db.driver
    .insert()
    .into(AUTHZ_ASSIGNMENT_TABLE)
    .values({ id: a.id, ...subjectToColumns(a.subject), role: a.role, ...scopeToColumns(a.scope), tags: normaliseTags(a.tags), expires_at: a.expiresAt ?? null, granted_by: a.grantedBy ? principalKey(a.grantedBy) : null, source: a.source ?? 'db', created_at: createdAt });
}

/** A world link as `authz.link` holds it (the token only hashed) and its `link:<id>` assignment, expiring with it. */
async function insertLink(db: TestDb, l: WorldLink): Promise<void> {
  const expiresAt = l.expiresAt ?? null;
  const createdAt = new Date();
  await db.driver
    .insert()
    .into(AUTHZ_LINK_TABLE)
    .values({ id: l.id, token_hash: linkTokenHash(LINK_SECRET, l.token), ...scopeToColumns(l.scope), attributes: JSON.stringify(l.attributes ?? {}), expires_at: expiresAt, revoked_at: l.revoked ? createdAt : null, created_by: l.createdBy ? principalKey(l.createdBy) : null, created_at: createdAt });
  // A revoked link keeps its assignment here: the link principal's empty ceiling must do the denying.
  await insertAssignment(db, { id: `link-${l.id}`, subject: { type: 'link', id: l.id }, role: l.role, scope: l.scope, ...(l.tags ? { tags: l.tags } : {}), ...(expiresAt ? { expiresAt } : {}), source: 'db' }, createdAt);
}

export type HarnessModel = 'rbac' | 'test';

export interface DbHarnessOptions {
  readonly facets?: readonly Facet[];
  /** AuthzAdmin with DbAuthzAdminBackend and the DB stores behind L9's ports. */
  readonly admin?: boolean;
  /** 'rbac' (default): L1's RbacModel; 'test': L9's TestRbacModel, as L9's admin harness runs it. */
  readonly model?: HarnessModel;
  /** Per case, with the model's options; default: the model's own. */
  readonly extensions?: (host: HostSetup, model: RbacModelOptions) => readonly RbacExtension[];
  /** The model's log (L1 warns about stored rows it ignores). */
  readonly log?: { warn(message: string): void };
  /** After the stores and the model are registered, before the domain boots. */
  register?(host: HostSetup, stores: DbHarnessStores): void | Promise<void>;
}

export interface DbHarnessStores {
  readonly roles: ConfigRoleStore;
  readonly assignments: DbAssignmentStore;
  readonly rules: DbRuleStore;
  readonly links: DbLinkStore;
  /** Absent with `model: 'test'`. */
  readonly model?: RbacModel;
}

let current: TestDb | undefined;

/** The test database of the running case. */
export function activeDb(): TestDb {
  if (!current) throw new Error('dbHarness: no test database is booted for this case');
  return current;
}

/** The backend reads Configuration and Orm from the test database's container (connection 'default'). */
export class DbHarnessBackend extends DbAuthzAdminBackend {
  constructor() {
    super({ container: activeDb().container });
  }
}

/**
 * hostHarness over a booted test database (real migrations): ConfigRoleStore reading the world's
 * roles and ladders from the host's configuration, the DB stores registered in the test domain and
 * L1's RbacModel over them. World assignments are planted as rows with their own ids. Lane handles
 * `store` (authz_version) and `rbacStore` (insertAssignment, linkRows). With `admin`: AuthzAdmin on
 * DbAuthzAdminBackend, the DB stores behind L9's ports, DefaultAdminGuard with the authz-rbac
 * defaults and a recording AuthzEventSink (`adminEvents`), as L9's admin harness wires its memory
 * stores.
 */
export function dbHarness(db: () => TestDb | undefined, opts: DbHarnessOptions = {}): BehaviourHarness {
  const models = new WeakMap<HostSetup, RbacModel>();
  const sinks = new WeakMap<HostSetup, RecordingEventSink>();
  const admin = opts.admin === true;

  return hostHarness({
    facets: ['rbac', 'store', ...(opts.model === 'test' ? [] : (['list'] as Facet[])), ...(admin ? (['admin', 'ladders', 'rules'] as Facet[]) : []), ...(opts.facets ?? [])],
    kitScopeAttributes: !admin,
    async register(host) {
      const test = db();
      if (!test) throw new Error('dbHarness: the test database is not booted');
      current = test;
      for (const table of CLEARED) await rawQuery(test.driver, `DELETE FROM ${table}`, [], QueryContext.Delete);

      const c = host.container;
      const rbac = host.world.rbac ?? {};
      if (rbac.roles) host.setConfig(['authz', 'rbac', 'roles'], roleConfig(rbac.roles as readonly RoleDef[]));
      if (rbac.ladders) host.setConfig(['authz', 'rbac', 'ladders'], ladderConfig(rbac.ladders as readonly LadderDef[]));
      host.setConfig(['authz', 'rbac', 'links', 'secret'], LINK_SECRET);

      c.register(instance(test.orm)).as(Orm);
      host.setConfig(['authz', 'rbac', 'stores'], HARNESS_STORES);
      const configuration = await c.resolve(Configuration);
      registerRbacStores(c, configuration);
      const roles = c.resolve(RoleStore) as ConfigRoleStore;
      const stores: DbHarnessStores = { roles, assignments: c.resolve(AdminAssignmentStore) as DbAssignmentStore, rules: c.resolve(AdminRuleStore) as DbRuleStore, links: c.resolve(AdminLinkStore) as DbLinkStore };
      // Each runBehaviour group installs its own TestConfiguration; a store holding an older one would read stale roles.
      if ((roles as unknown as { configuration: Configuration }).configuration !== configuration) throw new Error("dbHarness: the RoleStore does not read this case's Configuration");

      for (const a of rbac.assignments ?? []) await insertAssignment(test, a);
      for (const l of rbac.links ?? []) await insertLink(test, l);

      if (opts.model === 'test') {
        const { roles, ladders } = await stores.roles.load();
        c.register(instance(new TestRbacModel({ roles, ladders, assignments: stores.assignments }))).as(AuthorizationModel);
      } else {
        const options: RbacModelOptions = { roles: stores.roles, assignments: stores.assignments, links: stores.links, clock: host.kit.clock, ...(opts.log ? { log: opts.log } : {}) };
        const model = new RbacModel({ ...options, ...(opts.extensions ? { extensions: opts.extensions(host, options) } : {}) });
        models.set(host, model);
        c.register(instance(model)).as(AuthorizationModel);
        c.register(instance(new RbacContributor(model))).as(AuthzContributor);
      }

      if (admin) {
        const events = new RecordingEventSink();
        sinks.set(host, events);
        c.register(instance(events)).as(AuthzEventSink);
        c.register(DbHarnessBackend).as(AuthzAdminBackend);
        if (host.world.scopeAttributes) {
          const attributes = new MemoryScopeAttributeStore({ values: host.world.scopeAttributes.values ?? [] });
          c.register(instance(attributes)).as(ScopeAttributeStore);
          c.register(instance(attributes)).as(WritableScopeAttributeStore);
          const schemas = host.world.scopeAttributes.schemas ?? [];
          c.register(instance({ contribute: () => ({ scopeAttributeSchemas: schemas }) })).as(AuthzContributor);
        }
        // AuthzAdmin checks these for SYSTEM too, and a world that writes only as SYSTEM (B27.store) does
        // not declare them; an app using the RBAC write handlers declares them.
        const declared = new Set(host.world.permissions.map((p) => (typeof p === 'string' ? p : p.name)));
        for (const p of ADMIN_PERMISSIONS) if (!declared.has(p)) host.setConfig(['authz', 'domains', host.domain, 'permissions', p], {});
        // As L9's harness: the world's config.admin over the authz-rbac guard defaults.
        host.setConfig(['authz', 'admin'], { ...adminConfig.authz.admin, ...(host.world.config?.admin as object | undefined), guard: { ...adminConfig.authz.admin.guard, ...((host.world.config?.admin as { guard?: object } | undefined)?.guard ?? {}) }, backend: 'DbHarnessBackend' });
      }

      const model = models.get(host);
      await opts.register?.(host, { ...stores, ...(model ? { model } : {}) });
    },
    extend(host, session) {
      const test = activeDb();
      const model = models.get(host);
      const events = sinks.get(host);
      return {
        ...(model ? { list: (principal: Principal, permission: Permission, type: ResourceType) => list(host, session, model, principal, permission, type) } : {}),
        ...(admin ? { admin: (session.authz as unknown as AuthzService).admin() } : {}),
        lane: {
          store: { version: (domain: string) => readVersion(test.driver, domain) },
          rbacStore: {
            insertAssignment: (a: Assignment) => insertAssignment(test, a),
            linkRows: async () => (await test.driver.select().from(AUTHZ_LINK_TABLE)) as Record<string, unknown>[],
          },
          ...(events ? { adminEvents: events } : {}),
          ...(model ? { rbacLinks: { principal: (token: string, companion?: Principal) => new RbacService(model).principalForToken(token, companion) } } : {}),
        },
      };
    },
  });
}

/** The world rows the domain's type-level residual selects, evaluated in memory with the model's native filters (B06), as L1's harness lists. */
export async function list(host: HostSetup, session: HarnessSession, model: RbacModel, principal: Principal, permission: Permission, type: ResourceType): Promise<readonly string[]> {
  const authz = session.authz;
  if (!authz?.filter) throw new Error('dbHarness list: the session has no filter');
  const residual = await authz.filter(principal, permission, type);
  const speaker = principal.onBehalfOf && principal.delegation === 'inherit' ? principal.onBehalfOf : principal;
  const nativeFilters = model.extensions.flatMap((e) => e.nativeFilters?.() ?? []);
  const context = host.kit.context();
  const out: string[] = [];
  for (const row of host.kit.rows(type)) {
    if ((await evaluateFilter(residual, row, { principal: speaker, actor: principal, ref: { type, id: row.id }, context, nativeFilters })) === true) out.push(row.id);
  }
  return out;
}
