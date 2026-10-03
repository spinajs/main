import { GLOBAL } from '@spinajs/authz';
import type { AuthzCommand, Policy, Principal, ResourceRef } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { assignment, combine, fixture, ref, role } from './dsl.js';
import { exec, impersonates } from './model-steps.js';
import type { Via } from './model-steps.js';
import type { Case, CoversStep, FakeRbacSpec, World } from './types.js';

const O1 = ref('org', 'o1');
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const f1 = ref('file', 'f1');

const DOC = ['doc:read', 'doc:write', 'doc:delete'];
const covers = (holder: string, target: string, expect: boolean): CoversStep => ({ covers: { holder, target }, expect });

// ---------------------------------------------------------------------------------------------
// core: AuthzService.covers over the kit FakeRbacModel, whose votes and summaries agree.

const users = (...ids: string[]): Record<string, Principal> => Object.fromEntries(ids.map((id) => [id, userPrincipal(id)]));

const fakeRbac = (name: string, roles: FakeRbacSpec['roles'], assignments: readonly [string, string][]): FakeRbacSpec => ({ kind: 'fake-rbac', name, roles, assignments: assignments.map(([id, r]) => ({ subject: { type: 'user', id }, role: r })) });

const ROLES: FakeRbacSpec['roles'] = { all: ['doc:*'], writer: ['doc:read', 'doc:write'], reader: ['doc:read'], ownerWriter: [{ permission: 'doc:write', relation: 'owner' }], deleter: ['doc:delete'] };

const coreWorld = (models: FakeRbacSpec[]): World => ({
  permissions: DOC,
  principals: users('root', 'ed', 'ed2', 'viewer', 'ownerEd', 'condHolder', 'deleteOnly', 'mixed'),
  combine: combine('deny-overrides', ...models.map((m) => m.name ?? 'rbac')),
  models,
});

const one = coreWorld([
  fakeRbac('rbac', ROLES, [
    ['root', 'all'],
    ['ed', 'writer'],
    ['ed2', 'writer'],
    ['viewer', 'reader'],
    ['ownerEd', 'reader'],
    ['ownerEd', 'ownerWriter'],
    ['condHolder', 'reader'],
    ['condHolder', 'ownerWriter'],
    ['condHolder', 'deleter'],
  ]),
]);

// rbac gives read/write, extra gives delete: the combined set spans both models.
const two = coreWorld([
  fakeRbac('rbac', ROLES, [
    ['root', 'all'],
    ['ed', 'writer'],
    ['mixed', 'writer'],
    ['deleteOnly', 'reader'],
  ]),
  fakeRbac('extra', ROLES, [
    ['mixed', 'deleter'],
    ['deleteOnly', 'deleter'],
  ]),
]);

const coreCases: Case[] = [
  { name: "a holder whose set strictly contains the target's covers it", world: one, steps: [covers('ed', 'viewer', true), covers('root', 'ed', true)] },
  { name: 'equal sets are refused: the subset must be strict', world: one, steps: [covers('ed', 'ed2', false), covers('ed', 'ed', false)] },
  { name: 'a target permission the holder lacks is refused', world: one, steps: [covers('viewer', 'ed', false)] },
  { name: 'an unconditional entry covers a conditional one', world: one, steps: [covers('root', 'ownerEd', true)] },
  { name: 'a conditional entry does not cover an unconditional one', world: one, steps: [covers('condHolder', 'ed', false)] },
  { name: 'the combined set spans every model', world: two, steps: [covers('root', 'deleteOnly', true), covers('ed', 'deleteOnly', false), covers('mixed', 'deleteOnly', true), covers('deleteOnly', 'mixed', false)] },
];

// ---------------------------------------------------------------------------------------------
// abac: ABAC permit and deny policies count, with conditions bound for each principal.

const people: Record<string, Principal> = {
  ops: userPrincipal('ops', { attributes: { dept: 'ops' } }),
  root2: userPrincipal('root2', { attributes: { dept: 'dev' } }),
  t: userPrincipal('t'),
  u: userPrincipal('u', { attributes: { team: 'x' } }),
  hw: userPrincipal('hw'),
  low: userPrincipal('low', { attributes: { level: 'low' } }),
  high: userPrincipal('high', { attributes: { level: 'high' } }),
  highHolder: userPrincipal('highHolder', { attributes: { level: 'high' } }),
  v: userPrincipal('v'),
};

const abacWorld = (policies: readonly Omit<Policy, 'source'>[], principals: Record<string, Principal> = people): World => ({
  permissions: DOC,
  principals,
  combine: combine('deny-overrides', 'rbac', 'abac'),
  models: [
    fakeRbac('rbac', ROLES, [
      ['ops', 'all'],
      ['root2', 'all'],
      ['t', 'reader'],
      ['t', 'deleter'],
      ['u', 'reader'],
      ['hw', 'writer'],
      ['low', 'writer'],
      ['high', 'reader'],
      ['highHolder', 'writer'],
      ['v', 'reader'],
    ]),
  ],
  abac: { policies: policies.map((p) => ({ ...p, source: 'test' })) },
});

const OPS_NO_DELETE: Omit<Policy, 'source'> = { id: 'ops-no-delete', effect: 'deny', permissions: ['doc:delete'], when: { attr: 'principal.attributes.dept', eq: 'ops' } };

const abacCases: Case[] = [
  {
    name: "an ABAC deny policy takes a permission out of the holder's set",
    world: abacWorld([OPS_NO_DELETE], { ...people, t: userPrincipal('t', { attributes: { dept: 'dev' } }) }),
    steps: [covers('ops', 't', false), covers('root2', 't', true)],
  },
  {
    name: 'a deny policy on an attribute the target lacks is UNKNOWN for it, which denies (RFC L3-1)',
    world: abacWorld([OPS_NO_DELETE]),
    steps: [{ check: { as: 't', permission: 'doc:delete' }, expect: { allowed: false } }, covers('ops', 't', true), covers('root2', 't', true)],
  },
  {
    name: "an ABAC permit policy adds to the target's set",
    world: abacWorld([{ id: 'team-x-writes', effect: 'permit', permissions: ['doc:write'], when: { attr: 'principal.attributes.team', eq: 'x' } }]),
    steps: [covers('hw', 'u', false), covers('root2', 'u', true)],
  },
  {
    name: 'conditions are bound for each principal',
    world: abacWorld([{ id: 'high-deletes', effect: 'permit', permissions: ['doc:delete'], when: { attr: 'principal.attributes.level', eq: 'high' } }]),
    steps: [covers('low', 'high', false), covers('highHolder', 'high', true)],
  },
  {
    name: 'an unconditional entry covers a conditional ABAC entry',
    world: abacWorld([{ id: 'own-writes', effect: 'permit', permissions: ['doc:write'], when: { attr: 'resource.owner', eq: { ref: 'principal.id' } } }]),
    steps: [covers('root2', 'v', true)],
  },
];

// ---------------------------------------------------------------------------------------------
// guard: DefaultAdminGuard for every AuthzAdmin command (design §6.6.2).

const TYPES = ['org', 'project', 'file'];
const ADMIN_PERMISSIONS = ['authz:assignments.manage', 'authz:links.manage', 'authz:rules.manage'];

const guardPeople = users('bob', 'alice', 'root', 'root2', 'ops');

const guardWorld = (admins: readonly string[]): World => ({
  permissions: [...['file:read', 'file:write', 'project:settings', ...ADMIN_PERMISSIONS].map((name) => ({ name, types: TYPES })), 'users:update'],
  principals: guardPeople,
  scopes: [
    {
      nodes: [
        { ref: P1, parent: O1 },
        { ref: f1, parent: P1 },
        { ref: P2, parent: O1 },
      ],
    },
  ],
  combine: combine('deny-overrides', 'rbac'),
  config: { admin: { guard: { privilegedPermission: 'users:update', preventEscalation: true, preventSelfLockout: true, preventLastPrivilegedRemoval: true } } },
  rbac: {
    ladders: [{ name: 'project', roles: ['viewer', 'editor', 'maintainer'] }],
    roles: [role('viewer', ['file:read'], { ladder: 'project' }), role('editor', ['file:write'], { ladder: 'project' }), role('maintainer', ['project:settings'], { ladder: 'project' }), role('manager', ADMIN_PERMISSIONS), role('admin', ['users:update', 'authz:assignments.manage']), role('ops', ['authz:assignments.manage']), role('package', ['file:read'], { assignable: false }), role('org.admin', ['project:settings'], { scopeTypes: ['org'] })],
    assignments: [assignment('b1', guardPeople.bob, 'editor', P1), assignment('b2', guardPeople.bob, 'manager', P1), assignment('o1', guardPeople.ops, 'ops'), ...admins.map((id) => assignment(`a-${id}`, guardPeople[id], 'admin'))],
  },
});

const grant = (roleName: string, scope: ResourceRef = P1, id = 'alice'): AuthzCommand => ({ kind: 'assignment.grant', subject: { type: 'user', id }, role: roleName, scope });
const revoke = (id: string): AuthzCommand => ({ kind: 'assignment.revoke', id });
const twoAdmins = guardWorld(['root', 'root2']);

const guardCases = (via: Via): Case[] => [
  { name: 'the role must exist', world: twoAdmins, steps: [exec('bob', [grant('ghost')], { failsAt: 0, code: 'unknown_role' }, { via })] },
  { name: 'the role must be assignable', world: twoAdmins, steps: [exec('bob', [grant('package')], { failsAt: 0, code: 'not_assignable' }, { via })] },
  { name: 'the role must be assignable at the scope type', world: twoAdmins, steps: [exec('bob', [grant('org.admin')], { failsAt: 0, code: 'wrong_scope_type' }, { via })] },
  { name: 'the actor must cover the role it grants (no escalation)', world: twoAdmins, steps: [exec('bob', [grant('admin')], { failsAt: 0, code: 'escalation' }, { via }), exec('bob', [grant('manager')], 'ok', { via })] },
  {
    name: "a ladder role may be granted up to the actor's own rank at the scope",
    world: twoAdmins,
    steps: [exec('bob', [grant('maintainer')], { failsAt: 0, code: 'escalation' }, { via }), exec('bob', [grant('editor')], 'ok', { via }), exec('bob', [grant('viewer', P1, 'root')], 'ok', { via })],
  },
  { name: 'no self-lockout: the actor cannot revoke its own privileged role', world: twoAdmins, steps: [exec('root', [revoke('a-root')], { failsAt: 0, code: 'self_lockout' }, { via })] },
  {
    name: 'the last holder of privilegedPermission at GLOBAL keeps it',
    world: guardWorld(['root']),
    steps: [exec('ops', [revoke('a-root')], { failsAt: 0, code: 'last_holder' }, { via }), { check: { as: 'root', permission: 'users:update', resource: GLOBAL }, expect: { allowed: true } }],
  },
  { name: 'a holder that is not the last may lose it', world: twoAdmins, steps: [exec('ops', [revoke('a-root2')], 'ok', { via }), { check: { as: 'root2', permission: 'users:update', resource: GLOBAL }, expect: { allowed: false } }] },
  {
    name: "a link may not grant a role above the actor's own at the scope",
    world: twoAdmins,
    steps: [exec('bob', [{ kind: 'link.create', scope: P1, role: 'maintainer' }], { failsAt: 0, code: 'escalation' }, { via }), exec('bob', [{ kind: 'link.create', scope: P1, role: 'viewer' }], 'ok', { via })],
  },
  {
    name: "a rule may not require a role above the actor's own at the scope",
    world: twoAdmins,
    steps: [exec('bob', [{ kind: 'rule.put', rule: { id: 'thr-high', kind: 'threshold', scope: P1, permissions: ['file:read'], minRole: 'maintainer' } }], { failsAt: 0, code: 'escalation' }, { via }), exec('bob', [{ kind: 'rule.put', rule: { id: 'thr-low', kind: 'threshold', scope: P1, permissions: ['file:read'], minRole: 'viewer' } }], 'ok', { via })],
  },
];

// ---------------------------------------------------------------------------------------------
// impersonation: users' AuthzImpersonationGuard (C3).

const imp: Record<string, Principal> = {
  sup: userPrincipal('sup', { attributes: { dept: 'support' } }),
  peer: userPrincipal('peer', { attributes: { dept: 'support' } }),
  mem: userPrincipal('mem'),
  del: userPrincipal('del'),
  adm: userPrincipal('adm'),
  nobody: userPrincipal('nobody'),
};

const impWorld = (policies: readonly Omit<Policy, 'source'>[]): World => ({
  permissions: [...DOC, 'user:impersonate'],
  principals: imp,
  combine: combine('deny-overrides', 'rbac', 'abac'),
  config: { impersonation: { permission: 'user:impersonate', protectedRoles: ['admin'] } },
  rbac: {
    roles: [role('support', ['user:impersonate', 'doc:*']), role('admin', ['doc:read']), role('member', ['doc:read']), role('deleter', ['doc:read', 'doc:delete']), role('plain', ['doc:*'])],
    assignments: [assignment('s1', imp.sup, 'support'), assignment('s2', imp.peer, 'support'), assignment('m1', imp.mem, 'member'), assignment('d1', imp.del, 'deleter'), assignment('a1', imp.adm, 'admin'), assignment('n1', imp.nobody, 'plain')],
  },
  abac: { policies: policies.map((p) => ({ ...p, source: 'test' })) },
});

const noPolicies = impWorld([]);
const supportNoDelete = impWorld([{ id: 'support-no-delete', effect: 'deny', permissions: ['doc:delete'], when: { attr: 'principal.attributes.dept', eq: 'support' } }]);

const impersonationCases: Case[] = [
  { name: 'a holder of user:impersonate with a strictly larger set may impersonate', world: noPolicies, steps: [impersonates('sup', 'mem', { ok: true }), impersonates('sup', 'del', { ok: true })] },
  { name: 'without user:impersonate impersonation is refused', world: noPolicies, steps: [impersonates('nobody', 'mem', { ok: false })] },
  { name: 'an equal permission set is refused', world: noPolicies, steps: [impersonates('sup', 'peer', { ok: false })] },
  { name: 'a target holding a protected role is refused', world: noPolicies, steps: [impersonates('sup', 'adm', { ok: false, code: 'protected_role' })] },
  { name: 'an ABAC deny policy on the caller counts in the subset rule (H18)', world: supportNoDelete, steps: [impersonates('sup', 'del', { ok: false }), impersonates('sup', 'mem', { ok: true })] },
];

export const B26 = fixture('B26', [
  {
    name: 'core',
    facets: ['engine'],
    lanes: ['F3'],
    note: "AuthzService.covers (F3 task 4: strict subset of the combined summaries; an unconditional entry covers a conditional one) over two kit FakeRbacModels. F3's acceptance list lacks B26: F3 should add B26.core. Left open by the design: whether a conditional entry covers a conditional one, and whether equal names with a stronger entry make a strict superset; no case asserts either.",
    cases: coreCases,
  },
  {
    name: 'abac',
    facets: ['engine', 'abac', 'conditions'],
    lanes: ['L3', 'C3'],
    note: "H18: ABAC permit and deny policies count in covers (L3 task 7 summarize; C3). L3's run list lacks B26: L3 should add B26.abac.",
    cases: abacCases,
  },
  {
    name: 'guard',
    facets: ['engine', 'rbac', 'ladders', 'admin'],
    lanes: ['L9'],
    note: 'bob holds editor and manager (the authz:*.manage permissions) at p1; root and root2 hold admin (users:update, the privilegedPermission) at GLOBAL; ops may manage assignments at GLOBAL. "System role never assignable via API" is left to L9: design §18.1 removes rbac.systemRole (system is a principal), so no role is named a system role in 3.0 config. The guard is not asked to cover a role on revoke (§6.6.2 names covers for the role it grants only, as the r2 RoleGuard did); otherwise no actor but a holder could reach last_holder.',
    cases: guardCases('admin'),
  },
  { name: 'http', facets: ['http', 'engine', 'rbac', 'ladders'], lanes: ['C4'], note: 'The guard cases through POST /authz/commands (lane handle adminHttp).', cases: guardCases('http') },
  {
    name: 'impersonation',
    facets: ['impersonation', 'rbac', 'abac', 'conditions'],
    lanes: ['C3'],
    note: 'Lane handle impersonationGuard. Which refusal code (forbidden, escalation) answers a missing user:impersonate or a set that is not a strict subset is not specified, so only protected_role is asserted. Fresh auth, an MFA-satisfied session and the maximum duration (A20) are authn rules in authn-testing.',
    cases: impersonationCases,
  },
]);
