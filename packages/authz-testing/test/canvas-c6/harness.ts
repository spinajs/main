import { readFileSync } from 'node:fs';

import { AuthorizationModel, AuthzAdminBackend, AuthzContributor, MemoryAuthzAdminBackend, MemoryScopeAttributeStore, ScopeAttributeStore, ScopeResolver, WritableScopeAttributeStore } from '@spinajs/authz';
import type { AuthzService } from '@spinajs/authz';
import { AbacContributor, AbacModel } from '@spinajs/authz-abac';
import { AdminAssignmentStore, AdminLinkStore, AdminRuleStore, AssignmentStore, ConfigRoleStore, ConfigRuleStore, LinkStore, MemoryAdminAssignmentStore, MemoryLinkStore, MemoryRuleStore, RbacContributor, RbacModel, RbacService, RoleStore, RuleStore } from '@spinajs/authz-rbac';
import { Configuration } from '@spinajs/configuration';
import type { Class } from '@spinajs/di';

import { hostHarness, testHost } from '../../src/index.js';
import type { BehaviourHarness, Facet, HostSetup, World } from '../../src/index.js';
import { canvasAuthzConfig, readCapabilities } from './config.js';
import type { CapabilityTable } from './config.js';
import { C6Facade } from './facade.js';
import { CANVAS_FIXTURES_DIR, loadCanvasFixtures } from './fixtures.js';
import type { CanvasFixtures } from './fixtures.js';
import { loadCanvasState } from './load.js';
import type { CanvasLoad } from './load.js';
import { CanvasScopeResolver, canvasScopeContributor } from './scope.js';

const { instance } = testHost;

/** The canvas lane handle (`session.lane.canvas`). */
export interface CanvasHandle {
  readonly facade: C6Facade;
  readonly fixtures: CanvasFixtures;
  readonly load: CanvasLoad;
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

// AuthzAdmin checks set.addMember at the group scope, and §8.5 types no permission on `group`.
const ADMIN_EXTRA_TYPES: Readonly<Record<string, readonly string[]>> = Object.freeze({ 'org:manage': ['group'] });

/** The world of every canvas case: the generated §8.5 config, the admin section, and T0. */
export function canvasWorld(backend = 'CanvasMemoryAdminBackend'): World {
  const config = canvasAuthzConfig(CANVAS_CAPABILITIES);
  const { stores: _stores, ...rbac } = config.rbac;
  return {
    now: T0,
    permissions: Object.entries(config.permissions).map(([name, def]) => ({ name, types: [...def.types, ...(ADMIN_EXTRA_TYPES[name] ?? [])] })),
    combine: config.combine,
    principals: {},
    config: {
      rbac,
      abac: config.abac,
      admin: { guard: { ...ADMIN_GUARD }, backend, permissions: CANVAS_ADMIN_PERMISSIONS },
    },
  };
}

/** The writable stores of one case; task 7 adds a SQLite variant. */
export interface CanvasStores {
  readonly assignments: AdminAssignmentStore;
  readonly links: AdminLinkStore;
  readonly rules: AdminRuleStore;
  readonly attributes: WritableScopeAttributeStore;
  readonly backend: Class<AuthzAdminBackend>;
}

export type CanvasStoreKind = 'memory';

export interface CanvasHarnessOptions {
  readonly store: CanvasStoreKind;
}

function memoryStores(): CanvasStores {
  const assignments = new MemoryAdminAssignmentStore();
  return { assignments, links: new MemoryLinkStore(assignments), rules: new MemoryRuleStore(), attributes: new MemoryScopeAttributeStore(), backend: CanvasMemoryAdminBackend };
}

const STORE_BUILDERS: Readonly<Record<CanvasStoreKind, (host: HostSetup) => CanvasStores | Promise<CanvasStores>>> = { memory: memoryStores };

const FACETS: readonly Facet[] = ['canvas', 'admin', 'rbac', 'ladders', 'rules', 'links', 'abac', 'conditions', 'scopeAttributes'];

/**
 * hostHarness plus canvas C6: CanvasScopeResolver over state.json, the org attribute schema, RBAC and
 * ABAC models over the §8.5 config, writable stores, the state loaded through AuthzAdmin as SYSTEM,
 * and C6Facade over the domain's check (lane handle `canvas`).
 */
export function canvasHarness(opts: CanvasHarnessOptions): BehaviourHarness {
  const models = new WeakMap<HostSetup, RbacModel>();
  const fixtures = loadCanvasFixtures();

  return hostHarness({
    facets: FACETS,
    kitScopeAttributes: false,
    async register(host) {
      const c = host.container;
      const stores = await STORE_BUILDERS[opts.store](host);
      const configuration = (await c.resolve(Configuration)) as Configuration;

      c.register(instance(new CanvasScopeResolver(fixtures.state))).as(ScopeResolver);
      c.register(instance(canvasScopeContributor())).as(AuthzContributor);
      c.register(instance(stores.attributes)).as(ScopeAttributeStore);
      c.register(instance(stores.attributes)).as(WritableScopeAttributeStore);

      const roles = new ConfigRoleStore(configuration);
      c.register(instance(roles)).as(RoleStore);
      c.register(instance(stores.assignments)).as(AssignmentStore);
      c.register(instance(stores.assignments)).as(AdminAssignmentStore);
      c.register(instance(stores.links)).as(LinkStore);
      c.register(instance(stores.links)).as(AdminLinkStore);
      c.register(instance(stores.rules)).as(RuleStore);
      c.register(instance(stores.rules)).as(AdminRuleStore);
      c.register(stores.backend).as(AuthzAdminBackend);

      const rbac = new RbacModel({ roles, assignments: stores.assignments, links: stores.links, rules: [new ConfigRuleStore(configuration), stores.rules], clock: host.kit.clock });
      models.set(host, rbac);
      c.register(instance(rbac)).as(AuthorizationModel);
      c.register(instance(new RbacContributor(rbac))).as(AuthzContributor);

      const abac = new AbacModel();
      c.register(instance(abac)).as(AuthorizationModel);
      c.register(instance(new AbacContributor(abac))).as(AuthzContributor);
    },
    async extend(host, session) {
      const authz = session.authz as unknown as AuthzService;
      const admin = authz.admin();
      const load = await loadCanvasState(admin, fixtures, { capabilities: CANVAS_CAPABILITIES, expiredLinkExpiry: new Date(T0.getTime() + HOUR) });
      session.clock!.advance(2 * HOUR);
      const links = new RbacService(models.get(host)!);
      const facade = new C6Facade({
        check: (req) => authz.check(req),
        linkPrincipal: (id, companion) => links.linkPrincipal(id, companion),
        linkIds: load.linkIds,
        capabilities: CANVAS_CAPABILITIES,
        fileProject: (file) => fixtures.state.files.get(file)?.project,
      });
      return { admin, lane: { ...session.lane, canvas: { facade, fixtures, load } } };
    },
  });
}
