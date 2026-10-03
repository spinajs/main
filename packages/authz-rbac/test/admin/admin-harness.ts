import { hostHarness, testHost } from '@spinajs/authz-testing';
import type { BehaviourHarness, Facet, HostSetup } from '@spinajs/authz-testing';

import { AuthorizationModel, AuthzAdminBackend, AuthzContributor, AuthzEventSink, MemoryAuthzAdminBackend, MemoryScopeAttributeStore, ScopeAttributeStore, WritableScopeAttributeStore } from '@spinajs/authz';
import type { AuthzEvent, AuthzService } from '@spinajs/authz';

import adminConfig from '../../src/config/admin.js';
import { AdminAssignmentStore, AdminLinkStore, AdminRuleStore, AssignmentStore, LinkStore, MemoryAssignmentStore, MemoryLinkStore, MemoryRuleStore, RoleStore, RuleStore } from '../../src/index.js';
import type { LadderDef, RoleDef } from '../../src/index.js';
import { TestRbacModel } from './test-rbac-model.js';

const { instance } = testHost;

/** Per test domain: the shared root MemoryAuthzAdminBackend would carry idempotency keys from one case into the next. */
export class AdminHarnessBackend extends MemoryAuthzAdminBackend {}

/** The adminEvents lane handle. */
export class RecordingEventSink extends AuthzEventSink {
  readonly events: AuthzEvent[] = [];

  async publish(events: readonly AuthzEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

export class HarnessRoleStore extends RoleStore {
  readonly name = 'harness';

  constructor(private readonly roles: readonly RoleDef[], private readonly ladders: readonly LadderDef[]) {
    super();
  }

  async load() {
    return { roles: this.roles, ladders: this.ladders };
  }

  async version() {
    return '1';
  }
}

/** The stores one case runs on, for tests that look past AuthzAdmin. */
export interface HarnessStores {
  readonly assignments: MemoryAssignmentStore;
  readonly links: MemoryLinkStore;
  readonly rules: MemoryRuleStore;
  readonly attributes?: MemoryScopeAttributeStore;
  readonly model: TestRbacModel;
  readonly events: RecordingEventSink;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base: unknown, over: unknown): unknown {
  if (!isRecord(base) || !isRecord(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

export interface AdminHarnessOptions {
  readonly facets?: readonly Facet[];
}

const STORES = new WeakMap<object, HarnessStores>();

/** The stores of the case whose test domain is `container`. */
export function harnessStores(host: Pick<HostSetup, 'container'>): HarnessStores {
  const s = STORES.get(host.container);
  if (!s) throw new Error('adminHarness: no stores for this container');
  return s;
}

/**
 * hostHarness plus the AuthzAdmin side of authz-rbac: memory assignment, link and rule stores seeded
 * from `world.rbac`, a role store from its roles and ladders, a TestRbacModel named `rbac` over the
 * assignment store, DefaultAdminGuard with the authz-rbac defaults under the world's `config.admin`,
 * a recording AuthzEventSink (lane handle `adminEvents`) and, when the world has `scopeAttributes`, a
 * writable memory attribute store with its schemas.
 */
export function adminHarness(opts: AdminHarnessOptions = {}): BehaviourHarness {
  return hostHarness({
    facets: ['admin', 'rbac', 'ladders', ...(opts.facets ?? [])],
    kitScopeAttributes: false,
    register(host) {
      const c = host.container;
      const rbac = host.world.rbac ?? {};
      const roles = (rbac.roles ?? []) as readonly RoleDef[];
      const ladders = (rbac.ladders ?? []) as readonly LadderDef[];

      const assignments = new MemoryAssignmentStore({ assignments: rbac.assignments });
      const links = new MemoryLinkStore(assignments, {
        links: (rbac.links ?? []).filter((l) => !l.revoked).map((l) => ({ link: { id: l.id, scope: l.scope, expiresAt: l.expiresAt ?? null, attributes: l.attributes ?? {}, ...(l.createdBy ? { createdBy: l.createdBy } : {}) }, token: l.token, role: l.role, tags: l.tags })),
      });
      const rules = new MemoryRuleStore({ rules: rbac.rules });
      const model = new TestRbacModel({ roles, ladders, assignments });
      const events = new RecordingEventSink();

      c.register(instance(assignments)).as(AssignmentStore);
      c.register(instance(assignments)).as(AdminAssignmentStore);
      c.register(instance(links)).as(LinkStore);
      c.register(instance(links)).as(AdminLinkStore);
      c.register(instance(rules)).as(RuleStore);
      c.register(instance(rules)).as(AdminRuleStore);
      c.register(instance(new HarnessRoleStore(roles, ladders))).as(RoleStore);
      c.register(instance(model)).as(AuthorizationModel);
      c.register(instance(events)).as(AuthzEventSink);
      c.register(AdminHarnessBackend).as(AuthzAdminBackend);

      let attributes: MemoryScopeAttributeStore | undefined;
      if (host.world.scopeAttributes) {
        attributes = new MemoryScopeAttributeStore({ values: host.world.scopeAttributes.values ?? [] });
        c.register(instance(attributes)).as(ScopeAttributeStore);
        c.register(instance(attributes)).as(WritableScopeAttributeStore);
        const schemas = host.world.scopeAttributes.schemas ?? [];
        c.register(instance({ contribute: () => ({ scopeAttributeSchemas: schemas }) })).as(AuthzContributor);
      }

      // hostHarness puts the world's config.admin in place of the whole section; a real config merges it over
      // the authz-rbac fragment, so the guard defaults come back here.
      host.setConfig(['authz', 'admin'], deepMerge(deepMerge(adminConfig.authz.admin, host.world.config?.admin), { backend: 'AdminHarnessBackend' }));

      STORES.set(c, { assignments, links, rules, model, events, ...(attributes ? { attributes } : {}) });
    },
    extend: (host, session) => ({
      admin: (session.authz as unknown as AuthzService).admin(),
      lane: { adminEvents: harnessStores(host).events },
    }),
  });
}
