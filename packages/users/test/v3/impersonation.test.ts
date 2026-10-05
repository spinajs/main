import 'mocha';

import { AuthorizationModel, AuthzContributor } from '@spinajs/authz';
import { MemoryAssignmentStore, MemoryRoleStore, RbacContributor, RbacModel } from '@spinajs/authz-rbac';
import type { ImpersonationGuard } from '@spinajs/authn/contracts';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { BEHAVIOUR_FIXTURES, fixtureDsl, hostHarness, runBehaviour, testHost, userPrincipal } from '@spinajs/authz-testing';
import type { Case, CoversStep, World } from '@spinajs/authz-testing';
import { expect } from 'chai';

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

const world: World = {
  permissions: PERMISSIONS,
  principals: Object.fromEntries(WHO.map((id) => [id, userPrincipal(id)])),
  combine: combine('deny-overrides', 'rbac'),
  adapters: [{ types: ['users'], rows: { users: [{ id: 'u1', owner: 'usr' }] }, relations: [{ type: 'users', relation: 'owner', column: 'owner' }] }],
  rbac: {
    roles: ROLES,
    assignments: Object.entries(HELD).map(([id, r]) => assignment(`a-${id}`, userPrincipal(id), r)),
  },
};

// A stored row naming a role that left the config; AuthzAdmin and the world validation refuse to write one.
const STALE = [assignment('a-ghost', userPrincipal('ghost'), 'ghost-role')];

let warnings: string[] = [];

const covers = (holder: string, target: string, expected: boolean): CoversStep => ({ covers: { holder, target }, expect: expected });

const cases: Case[] = [
  { name: 'denies user → admin (privilege escalation)', world, steps: [covers('usr', 'adm', false)] },
  { name: 'denies admin → admin (equal privileges count as escalation)', world, steps: [covers('adm', 'adm2', false)] },
  { name: 'denies moderator → admin (target has grants moderator lacks)', world, steps: [covers('mod', 'adm', false)] },
  { name: 'allows admin → user', world, steps: [covers('adm', 'usr', true)] },
  { name: "refuses admin → guest (admin's set lacks public:read)", world, steps: [covers('adm', 'gst', false)] },
  { name: 'honors $extend when comparing grants', world, steps: [covers('sup', 'basic', true)] },
  {
    name: 'treats target with unknown role as having no grants (still allowed by superset check)',
    world,
    steps: [
      covers('adm', 'ghost', true),
      { do: () => { expect(warnings.some((w) => w.includes('ghost-role'))).to.equal(true, `no warning for the unknown role in ${JSON.stringify(warnings)}`); }, note: 'B12: the unknown stored role is ignored with a warning' },
    ],
  },
];

const harness = () =>
  hostHarness({
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

  runBehaviour(['B26.users-impersonation'], harness, {
    strict: true,
    timeoutMs: 30_000,
    fixtures: [...BEHAVIOUR_FIXTURES, extension('B26', [{ name: 'users-impersonation', facets: ['engine', 'rbac'], lanes: ['T1'], cases }])],
  });

  describe('protected roles (A20)', () => {
    // PENDING(C3): AuthzImpersonationGuard does not exist yet; C3 builds it over the host harness above and
    // sets authz.impersonation.protectedRoles per row.
    const guardFor = (_protectedRoles: readonly string[]): ImpersonationGuard => {
      throw new Error('PENDING(C3): AuthzImpersonationGuard');
    };

    // adm holds user:impersonate and covers sys, so only the protected role can refuse it.
    it.skip('denies when target has a protected role', async () => {
      const res = await guardFor(['system']).allowed(userPrincipal('adm'), { type: 'user', id: 'sys' });
      expect(res).to.deep.equal({ ok: false, code: 'protected_role' });
    });

    // The same target as above, which the default ['system'] would refuse.
    it.skip('does not flag protected role when protectedRoles is empty', async () => {
      const res = await guardFor([]).allowed(userPrincipal('adm'), { type: 'user', id: 'sys' });
      expect(res).to.deep.equal({ ok: true });
    });
  });
});
