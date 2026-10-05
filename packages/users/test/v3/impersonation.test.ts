import 'mocha';

import { AuthorizationModel, AuthzContributor } from '@spinajs/authz';
import { MemoryAssignmentStore, MemoryRoleStore, RbacContributor, RbacModel, RbacService } from '@spinajs/authz-rbac';
import { PrincipalFactory } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef, ImpersonationGuard, Principal } from '@spinajs/authn/contracts';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { BEHAVIOUR_FIXTURES, fixtureDsl, hostHarness, runBehaviour, testHost, userPrincipal } from '@spinajs/authz-testing';
import type { Case, CoversStep, DoStep, World } from '@spinajs/authz-testing';
import { expect } from 'chai';

import { AuthzImpersonationGuard } from '../../src/index.js';

const { assignment, combine, extension, role } = fixtureDsl;

const PERMISSIONS = ['users:create', 'users:read', 'users:update', 'users:delete', 'user:impersonate', 'public:read'];

// The 2.x fixture with "own" grants as owner-relation grants. Role names admin2 and basic stand for the
// local admin and user of the legacy $extend row. system holds only users:read here (legacy: everything), so
// admin covers it and only the protected-role rule can refuse it.
const ROLES = [
  role('system', ['users:read']),
  role('admin', ['users:create', 'users:read', 'users:update', 'users:delete', 'user:impersonate']),
  role('moderator', ['users:read', 'users:update']),
  role('user', [
    { permission: 'users:read', relation: 'owner' },
    { permission: 'users:update', relation: 'owner' },
  ]),
  role('guest', ['public:read']),
  role('admin2', ['users:read', 'users:update']),
  role('superadmin', [], { extends: ['admin2'] }),
  role('basic', [{ permission: 'users:read', relation: 'owner' }]),
];

const WHO = ['sys', 'adm', 'adm2', 'mod', 'usr', 'gst', 'sup', 'basic', 'ghost'];
const HELD: Record<string, string> = { sys: 'system', adm: 'admin', adm2: 'admin', mod: 'moderator', usr: 'user', gst: 'guest', sup: 'superadmin', basic: 'basic' };

const DOMAIN = 'test';

// The guard reads its domain and protected roles from config; system plays the legacy protected role.
const guardConfig = (protectedRoles: readonly string[]) => ({ http: { access: { domain: DOMAIN } }, impersonation: { protectedRoles: [...protectedRoles] } });

const worldWith = (roles: typeof ROLES, protectedRoles: readonly string[] = ['system']): World => ({
  permissions: PERMISSIONS,
  principals: Object.fromEntries(WHO.map((id) => [id, userPrincipal(id)])),
  combine: combine('deny-overrides', 'rbac'),
  adapters: [{ types: ['users'], rows: { users: [{ id: 'u1', owner: 'usr' }] }, relations: [{ type: 'users', relation: 'owner', column: 'owner' }] }],
  rbac: {
    roles,
    assignments: Object.entries(HELD).map(([id, r]) => assignment(`a-${id}`, userPrincipal(id), r)),
  },
  config: guardConfig(protectedRoles),
});

const world = worldWith(ROLES);

// A stored row naming a role that left the config; AuthzAdmin and the world validation refuse to write one.
const STALE = [assignment('a-ghost', userPrincipal('ghost'), 'ghost-role')];

let warnings: string[] = [];

const covers = (holder: string, target: string, expected: boolean): CoversStep => ({ covers: { holder, target }, expect: expected });

const FACTS: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date('2026-10-01T10:00:00Z') };

/** The world's principals with the authn facts the guard hands over, as users' factory would build them. */
class WorldPrincipals extends PrincipalFactory {
  public async principalOf(id: IdentityRef, facts: AuthnFacts): Promise<Principal> {
    return userPrincipal(id.id, { authn: facts });
  }
}

const guardFor = (): ImpersonationGuard => new AuthzImpersonationGuard({ principals: new WorldPrincipals() });

type GuardAnswer = Awaited<ReturnType<ImpersonationGuard['allowed']>>;

const OK: GuardAnswer = { ok: true };
const refused = (code: 'forbidden' | 'escalation' | 'protected_role'): GuardAnswer => ({ ok: false, code });

const guarded = (actor: string, target: string, expected: GuardAnswer): DoStep => ({
  note: `AuthzImpersonationGuard ${actor} → ${target}`,
  do: async () => {
    expect(await guardFor().allowed(userPrincipal(actor, { authn: FACTS }), { type: 'user', id: target })).to.deep.equal(expected);
  },
});

// Rows 2-8 as T1 ported them (covers), then through the guard: usr, mod and sup lack user:impersonate.
const cases: Case[] = [
  { name: 'denies user → admin (privilege escalation)', world, steps: [covers('usr', 'adm', false), guarded('usr', 'adm', refused('forbidden'))] },
  { name: 'denies admin → admin (equal privileges count as escalation)', world, steps: [covers('adm', 'adm2', false), guarded('adm', 'adm2', refused('escalation'))] },
  { name: 'denies moderator → admin (target has grants moderator lacks)', world, steps: [covers('mod', 'adm', false), guarded('mod', 'adm', refused('forbidden'))] },
  { name: 'allows admin → user', world, steps: [covers('adm', 'usr', true), guarded('adm', 'usr', OK)] },
  { name: "refuses admin → guest (admin's set lacks public:read)", world, steps: [covers('adm', 'gst', false), guarded('adm', 'gst', refused('escalation'))] },
  { name: 'honors $extend when comparing grants', world, steps: [covers('sup', 'basic', true), guarded('sup', 'basic', refused('forbidden'))] },
  {
    name: 'treats target with unknown role as having no grants (still allowed by superset check)',
    world,
    steps: [
      covers('adm', 'ghost', true),
      { do: () => { expect(warnings.some((w) => w.includes('ghost-role'))).to.equal(true, `no warning for the unknown role in ${JSON.stringify(warnings)}`); }, note: 'B12: the unknown stored role is ignored with a warning' },
      guarded('adm', 'ghost', OK),
    ],
  },
];

const IMPERSONATING_SUPERADMIN = ROLES.map((r) => (r.name === 'superadmin' ? role('superadmin', ['user:impersonate'], { extends: ['admin2'] }) : r));

// Rows 1 and 9 (A20): adm holds user:impersonate and covers sys, so only the protected role can refuse it.
const guardCases: Case[] = [
  { name: 'denies when target has a protected role', world, steps: [covers('adm', 'sys', true), guarded('adm', 'sys', refused('protected_role'))] },
  { name: 'does not flag protected role when protectedRoles is empty', world: worldWith(ROLES, []), steps: [guarded('adm', 'sys', OK)] },
  { name: 'honors $extend for a superadmin that may impersonate', world: worldWith(IMPERSONATING_SUPERADMIN), steps: [covers('sup', 'basic', true), guarded('sup', 'basic', OK)] },
];

const harness = () =>
  hostHarness({
    domain: DOMAIN,
    facets: ['rbac'],
    async register(host) {
      warnings = [];
      const rbac = host.world.rbac ?? {};
      const model = new RbacModel({
        roles: new MemoryRoleStore(rbac.roles ?? [], []),
        assignments: new MemoryAssignmentStore([...(rbac.assignments ?? []), ...STALE]),
        clock: host.kit.clock,
        log: { warn: (m: string) => void warnings.push(String(m)) },
      });
      host.container.register(testHost.instance(model)).as(AuthorizationModel);
      host.container.register(testHost.instance(new RbacContributor(model))).as(AuthzContributor);
      host.container.register(testHost.instance(new RbacService(model))).as(RbacService);
    },
  });

// Earlier suites leave their own Configuration resolved in the root cache; hostHarness installs its own.
describe('impersonation (B26)', () => {
  const kept = new Map<string, unknown[]>();

  const stash = () => {
    const cache = DI.RootContainer.Cache;
    const keys = new Set<string>(['Configuration']);
    for (const inst of cache.get(Configuration) ?? []) keys.add((inst as object).constructor.name);
    for (const key of keys) {
      const held = cache.get(key);
      if (held) kept.set(key, [...held]);
      DI.RootContainer.uncache(key);
    }
  };

  // Earlier suites register their own Configuration classes; the first registered one would win over the harness's.
  let registered: unknown[] = [];
  const registrations = () => (DI.RootContainer.Registry as unknown as { registry: Map<string, unknown[]> }).registry.get('Configuration');

  before(() => {
    stash();
    const list = registrations();
    registered = list ? list.splice(0) : [];
  });

  after(() => {
    registrations()?.splice(0, Infinity, ...registered);
    for (const [key, held] of kept) for (const inst of held) DI.RootContainer.Cache.add(key, inst);
    kept.clear();
  });

  runBehaviour(['B26.users-impersonation', 'B26.users-impersonation-guard'], harness, {
    strict: true,
    timeoutMs: 30_000,
    fixtures: [
      ...BEHAVIOUR_FIXTURES,
      extension('B26', [
        { name: 'users-impersonation', facets: ['engine', 'rbac'], lanes: ['T1'], cases },
        { name: 'users-impersonation-guard', facets: ['engine', 'rbac'], lanes: ['T1', 'C3'], cases: guardCases },
      ]),
    ],
  });
});
