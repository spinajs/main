import 'mocha';

import { AuthorizationModel, AuthzContributor } from '@spinajs/authz';
import { MemoryAssignmentStore, MemoryRoleStore, RbacContributor, RbacModel } from '@spinajs/authz-rbac';
import type { ImpersonationGuard } from '@spinajs/authn/contracts';
import { BEHAVIOUR_FIXTURES, fixtureDsl, hostHarness, runBehaviour, testHost, userPrincipal } from '@spinajs/authz-testing';
import type { Case, CoversStep, World } from '@spinajs/authz-testing';
import { expect } from 'chai';

const { assignment, combine, extension, role } = fixtureDsl;

const PERMISSIONS = ['users:create', 'users:read', 'users:update', 'users:delete', 'user:impersonate', 'public:read'];
const ALL = [...PERMISSIONS];

// The 2.x fixture: system holds everything, admin the users CRUD and user:impersonate, "own" grants become owner-relation grants.
const ROLES = [
  role('system', ALL),
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

const covers = (holder: string, target: string, expected: boolean): CoversStep => ({ covers: { holder, target }, expect: expected });

const cases: Case[] = [
  { name: 'denies user → admin (privilege escalation)', world, steps: [covers('usr', 'adm', false)] },
  { name: 'denies admin → admin (equal privileges count as escalation)', world, steps: [covers('adm', 'adm2', false)] },
  { name: 'denies moderator → admin (target has grants moderator lacks)', world, steps: [covers('mod', 'adm', false)] },
  { name: 'allows admin → user', world, steps: [covers('adm', 'usr', true)] },
  { name: "refuses admin → guest (admin's set lacks public:read)", world, steps: [covers('adm', 'gst', false)] },
  { name: 'honors $extend when comparing grants', world, steps: [covers('sup', 'basic', true)] },
  { name: 'treats target with unknown role as having no grants (still allowed by superset check)', world, steps: [covers('adm', 'ghost', true)] },
];

const harness = () => {
  return hostHarness({
    facets: ['rbac'],
    async register(host) {
      const rbac = host.world.rbac ?? {};
      const model = new RbacModel({
        roles: new MemoryRoleStore(rbac.roles ?? [], []),
        assignments: new MemoryAssignmentStore([...(rbac.assignments ?? []), ...STALE]),
        clock: host.kit.clock,
        log: { warn: () => undefined },
      });
      host.container.register(testHost.instance(model)).as(AuthorizationModel);
      host.container.register(testHost.instance(new RbacContributor(model))).as(AuthzContributor);
    },
  });
};

runBehaviour(['B26.users-impersonation'], harness, {
  strict: true,
  timeoutMs: 30_000,
  fixtures: [...BEHAVIOUR_FIXTURES, extension('B26', [{ name: 'users-impersonation', facets: ['engine', 'rbac'], lanes: ['T1'], cases }])],
});

// The protected-role part of the rule lives in users' AuthzImpersonationGuard, which C3 has not built yet.
describe('canImpersonate protected roles (B26, A20)', () => {
  let guard!: ImpersonationGuard;

  // PENDING(C3): AuthzImpersonationGuard (protectedRoles from authz.impersonation.protectedRoles)
  it.skip('denies when target has a protected role', async () => {
    const res = await guard.allowed(userPrincipal('adm'), { type: 'user', id: 'sys' });
    expect(res).to.deep.equal({ ok: false, code: 'protected_role' });
  });

  // PENDING(C3): AuthzImpersonationGuard with authz.impersonation.protectedRoles set to []
  it.skip('does not flag protected role when protectedRoles is empty', async () => {
    const res = await guard.allowed(userPrincipal('adm'), { type: 'user', id: 'usr' });
    expect(res).to.deep.equal({ ok: true });
  });
});
