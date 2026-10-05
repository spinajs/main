import { readFileSync } from 'node:fs';

import { AuthorizationModel, AuthzAdminBackend, AuthzContributor, MemoryAuthzAdminBackend, MemoryScopeAttributeStore, ScopeAttributeStore, ScopeResolver, WritableScopeAttributeStore } from '@spinajs/authz';
import type { AuthzService } from '@spinajs/authz';
import { AbacContributor, AbacModel } from '@spinajs/authz-abac';
import { DbScopeAttributeStore } from '@spinajs/authz-orm';
import { AdminAssignmentStore, AdminLinkStore, AdminRuleStore, AssignmentStore, ConfigRoleStore, ConfigRuleStore, DbAuthzAdminBackend, LinkStore, MemoryAdminAssignmentStore, MemoryLinkStore, MemoryRuleStore, RbacContributor, RbacModel, RbacService, RoleStore, RuleStore, registerRbac } from '@spinajs/authz-rbac';
import { Configuration } from '@spinajs/configuration';
import type { Class } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { hostHarness, testHost } from '../../src/index.js';
import type { BehaviourHarness, Facet, HostSetup, World } from '../../src/index.js';
import { canvasAuthzConfig, readCapabilities } from './config.js';
import type { CapabilityTable } from './config.js';
import { bootCanvasDb, clearCanvasTables } from './db.js';
import type { CanvasDb } from './db.js';
import { C6Facade } from './facade.js';
import type { C6FacadeDeps } from './facade.js';
import { CANVAS_FIXTURES_DIR, loadCanvasFixtures } from './fixtures.js';
import type { CanvasFixtures } from './fixtures.js';
import { loadCanvasState } from './load.js';
import type { CanvasLoad } from './load.js';
import { CanvasScopeResolver, canvasScopeContributor } from './scope.js';

const { instance } = testHost;

/** The canvas lane handle (`session.lane.canvas`). */
export interface CanvasHandle {
  readonly facade: C6Facade;
  /** The facade's own deps, for callers that map a principal once and check it many times. */
  readonly deps: C6FacadeDeps;
  readonly fixtures: CanvasFixtures;
  readonly load: CanvasLoad;
  /** SQLite only: the connection the stores read and AuthzAdmin writes. */
  readonly driver?: OrmDriver;
}

declare module '../../src/behaviour/harness.js' {
  interface LaneHandles {
    canvas: CanvasHandle;
  }
}

export const T0 = new Date('2026-10-01T12:00:00.000Z');
const HOUR = 3600_000;

export const CANVAS_CAPABILITIES: CapabilityTable = readCapabilities(JSON.parse(readFileSync(`${CANVAS_FIXTURES_DIR}capabilities.json`, 'utf8')));

// Design §6.6.4 maps assignment.* at project and file, link.*, rule.* at file and project and scope.* at org;
// the other entries fill its gaps as authz-rbac's canvas admin test does.
export const CANVAS_ADMIN_PERMISSIONS = Object.freeze({
  'assignment.*': { project: 'grants:manage', file: 'grants:manage', org: 'org:manage' },
  'set.*': 'org:manage',
  'link.*': 'grants:manage',
  'rule.*': { project: 'project:settings', file: 'project:settings' },
  'scope.*': { org: 'org:manage', project: 'project:delete', file: 'project:delete' },
  'list.*': { org: 'org:manage', group: 'org:manage', project: 'grants:manage', file: 'grants:manage' },
  'list.rules': 'project:settings',
});

// authz-rbac's config/admin.ts guard defaults; the lib does not export the fragment.
const ADMIN_GUARD = Object.freeze({ service: 'DefaultAdminGuard', privilegedPermission: 'users:update', protectSystemRole: true, preventEscalation: true, preventSelfLockout: true, preventLastPrivilegedRemoval: true });

/** Per test domain: the root MemoryAuthzAdminBackend would carry idempotency keys from one case into the next. */
export class CanvasMemoryAdminBackend extends MemoryAuthzAdminBackend {}

let activeDb: CanvasDb | undefined;

/** DI builds the backend without arguments; this one reads Orm and Configuration from the canvas test database's container. */
export class CanvasDbAdminBackend extends DbAuthzAdminBackend {
  constructor() {
    if (!activeDb) throw new Error('CanvasDbAdminBackend: no canvas test database is booted');
    super({ container: activeDb.container });
  }
}

export type CanvasStoreKind = 'memory' | 'sqlite';

/** The admin backend of each store kind; canvasWorld names it in authz.admin.backend and the harness registers it. */
export const CANVAS_ADMIN_BACKENDS: Readonly<Record<CanvasStoreKind, Class<AuthzAdminBackend>>> = Object.freeze({ memory: CanvasMemoryAdminBackend, sqlite: CanvasDbAdminBackend });

/** authz.rbac.links.secret: DbLinkStore hashes the share link tokens with it. */
export const CANVAS_LINK_SECRET = 'k1-canvas-c6-link-secret-of-at-least-32-chars';

/**
 * The world of every canvas case: the generated §8.5 config, the admin section, and T0. In memory the stores
 * are built by hand, so `authz.rbac.stores` is left out; on SQLite it stays as generated and registerRbac reads it.
 */
export function canvasWorld(store: CanvasStoreKind): World {
  const config = canvasAuthzConfig(CANVAS_CAPABILITIES);
  const { stores, ...rbac } = config.rbac;
  return {
    now: T0,
    permissions: Object.entries(config.permissions).map(([name, def]) => ({ name, types: [...def.types] })),
    combine: config.combine,
    principals: {},
    config: {
      rbac: store === 'memory' ? rbac : { ...rbac, stores, links: { secret: CANVAS_LINK_SECRET } },
      abac: config.abac,
      admin: { guard: { ...ADMIN_GUARD }, backend: CANVAS_ADMIN_BACKENDS[store].name, permissions: CANVAS_ADMIN_PERMISSIONS },
    },
  };
}

export interface CanvasHarnessOptions {
  readonly store: CanvasStoreKind;
}

/** What a case's RBAC wiring hands the rest of the harness. */
interface CanvasRbac {
  readonly service: RbacService;
  readonly attributes: WritableScopeAttributeStore;
}

/** Memory stores built by hand (they take constructor arguments), each under its model port and its admin port. */
function registerMemoryRbac(host: HostSetup, configuration: Configuration): CanvasRbac {
  const c = host.container;
  const roles = new ConfigRoleStore(configuration);
  const assignments = new MemoryAdminAssignmentStore();
  const links = new MemoryLinkStore(assignments);
  const rules = new MemoryRuleStore();
  c.register(instance(roles)).as(RoleStore);
  c.register(instance(assignments)).as(AssignmentStore);
  c.register(instance(assignments)).as(AdminAssignmentStore);
  c.register(instance(links)).as(LinkStore);
  c.register(instance(links)).as(AdminLinkStore);
  c.register(instance(rules)).as(RuleStore);
  c.register(instance(rules)).as(AdminRuleStore);

  const model = new RbacModel({ roles, assignments, links, rules: [new ConfigRuleStore(configuration), rules], clock: host.kit.clock });
  c.register(instance(model)).as(AuthorizationModel);
  c.register(instance(new RbacContributor(model))).as(AuthzContributor);
  return { service: new RbacService(model), attributes: new MemoryScopeAttributeStore() };
}

/** The §8.5 stores by name through authz-rbac's registerRbac, over the canvas test database (tables cleared first). */
async function registerSqliteRbac(host: HostSetup, configuration: Configuration, db: CanvasDb): Promise<CanvasRbac> {
  const c = host.container;
  await clearCanvasTables(db.driver);
  c.register(instance(db.orm)).as(Orm);
  const { service } = await registerRbac(c, configuration, { clock: host.kit.clock });
  // A role store holding an earlier group's TestConfiguration would read stale roles.
  const roles = (await c.resolve(RoleStore)) as unknown as { configuration?: unknown };
  if (roles.configuration !== configuration) throw new Error("canvasHarness: the RoleStore does not read this case's Configuration");
  return { service, attributes: new DbScopeAttributeStore({ container: db.container }) };
}

const FACETS: Readonly<Record<CanvasStoreKind, readonly Facet[]>> = Object.freeze({
  memory: ['canvas', 'admin', 'rbac', 'ladders', 'rules', 'links', 'abac', 'conditions', 'scopeAttributes'],
  sqlite: ['canvas', 'admin', 'rbac', 'ladders', 'rules', 'links', 'abac', 'conditions', 'scopeAttributes', 'store', 'sql'],
});

/**
 * hostHarness plus canvas C6: CanvasScopeResolver over state.json, the org attribute schema, RBAC and
 * ABAC models over the §8.5 config, writable stores, the state loaded through AuthzAdmin as SYSTEM,
 * and C6Facade over the domain's check (lane handle `canvas`). `store: 'sqlite'` boots one SQLite
 * `:memory:` database with the real migrations for the harness and clears its authz tables per case.
 */
export function canvasHarness(opts: CanvasHarnessOptions): BehaviourHarness {
  const wired = new WeakMap<HostSetup, CanvasRbac>();
  const fixtures = loadCanvasFixtures();
  let db: CanvasDb | undefined;

  const base = hostHarness({
    facets: FACETS[opts.store],
    kitScopeAttributes: false,
    async register(host) {
      const c = host.container;
      const configuration = (await c.resolve(Configuration)) as Configuration;
      let rbac: CanvasRbac;
      if (opts.store === 'sqlite') {
        if (!db) throw new Error('canvasHarness: the SQLite database is not booted (beforeAll did not run)');
        activeDb = db;
        rbac = await registerSqliteRbac(host, configuration, db);
      } else {
        rbac = registerMemoryRbac(host, configuration);
      }
      wired.set(host, rbac);
      c.register(CANVAS_ADMIN_BACKENDS[opts.store]).as(AuthzAdminBackend);

      c.register(instance(new CanvasScopeResolver(fixtures.state))).as(ScopeResolver);
      c.register(instance(canvasScopeContributor())).as(AuthzContributor);
      c.register(instance(rbac.attributes)).as(ScopeAttributeStore);
      c.register(instance(rbac.attributes)).as(WritableScopeAttributeStore);

      const abac = new AbacModel();
      c.register(instance(abac)).as(AuthorizationModel);
      c.register(instance(new AbacContributor(abac))).as(AuthzContributor);
    },
    async extend(host, session) {
      const authz = session.authz as unknown as AuthzService;
      const admin = authz.admin();
      const load = await loadCanvasState(admin, fixtures, { capabilities: CANVAS_CAPABILITIES, expiredLinkExpiry: new Date(T0.getTime() + HOUR) });
      session.clock!.advance(2 * HOUR);
      const { service } = wired.get(host)!;
      const deps: C6FacadeDeps = {
        check: (req) => authz.check(req),
        linkPrincipal: (id, companion) => service.linkPrincipal(id, companion),
        linkIds: load.linkIds,
        capabilities: CANVAS_CAPABILITIES,
        fileProject: (file) => fixtures.state.files.get(file)?.project,
      };
      const facade = new C6Facade(deps);
      return { admin, lane: { ...session.lane, canvas: { facade, deps, fixtures, load, ...(db ? { driver: db.driver } : {}) } } };
    },
  });
  if (opts.store !== 'sqlite') return base;

  return {
    ...base,
    async beforeAll() {
      db = await bootCanvasDb();
      await base.beforeAll?.();
    },
    async afterAll() {
      try {
        await base.afterAll?.();
      } finally {
        if (activeDb === db) activeDb = undefined;
        await db?.dispose();
        db = undefined;
      }
    },
  };
}
