import { GLOBAL } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { assignment, combine, fixture, ref, role } from './dsl.js';
import type { Case, DecisionExpectation, World } from './types.js';

const O1 = ref('org', 'o1');
const O2 = ref('org', 'o2');
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const f1 = ref('file', 'f1');
const f2 = ref('file', 'f2');

const SCOPED = ['org', 'project', 'file'];

const root = userPrincipal('root');
const support = userPrincipal('support');

// The instance roles of design §8.2 next to the org and project ladders of §8.5 (H26: no instance role
// grants on org, project, file or branch, or implies a scoped role).
const world: World = {
  permissions: [...['org:manage', 'project:read', 'project:settings', 'file:edit'].map((name) => ({ name, types: SCOPED })), 'users:read', 'users:update', 'user:impersonate', 'authz:explain'],
  principals: { root, support },
  scopes: [
    {
      nodes: [
        { ref: P1, parent: O1 },
        { ref: f1, parent: P1 },
        { ref: P2, parent: O2 },
        { ref: f2, parent: P2 },
      ],
    },
  ],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    ladders: [
      { name: 'project', roles: ['viewer', 'editor', 'maintainer'], resourceTypes: ['project', 'file', 'branch'] },
      { name: 'org', roles: ['org.member', 'org.admin'] },
    ],
    roles: [role('admin.users', ['users:*'], { assignable: false }), role('admin', ['user:impersonate', 'authz:explain'], { extends: ['admin.users'] }), role('viewer', ['project:read'], { ladder: 'project' }), role('editor', ['file:edit'], { ladder: 'project' }), role('maintainer', ['project:settings'], { ladder: 'project' }), role('org.member', [], { ladder: 'org' }), role('org.admin', ['org:manage'], { ladder: 'org', implies: [{ role: 'maintainer', at: 'self-and-descendants', bypass: ['restrict', 'cap'] }] })],
    assignments: [assignment('r1', root, 'admin', GLOBAL), assignment('s1', support, 'admin', GLOBAL), assignment('s2', support, 'viewer', P1)],
  },
};

const NO_ACCESS: DecisionExpectation = { allowed: false, reason: 'no_access' };
const ALLOWED: DecisionExpectation = { allowed: true };

const cases: Case[] = [
  {
    name: "an instance admin without an org assignment gets no_access on that org's resources",
    steps: [
      { check: { as: 'root', permission: 'org:manage', resource: O1 }, expect: NO_ACCESS },
      { check: { as: 'root', permission: 'project:read', resource: P1 }, expect: NO_ACCESS },
      { check: { as: 'root', permission: 'project:settings', resource: P1 }, expect: NO_ACCESS },
      { check: { as: 'root', permission: 'file:edit', resource: f1 }, expect: NO_ACCESS },
    ],
  },
  {
    name: 'the instance roles still hold their instance permissions',
    steps: [{ checkMany: { as: 'root', permissions: ['users:update', 'user:impersonate', 'authz:explain'], resource: GLOBAL }, expect: { 'users:update': ALLOWED, 'user:impersonate': ALLOWED, 'authz:explain': ALLOWED } }],
  },
  {
    name: 'an instance admin with a scoped assignment gets that assignment only, nothing implied by the instance role',
    steps: [
      { check: { as: 'support', permission: 'project:read', resource: P1 }, expect: { allowed: true, roles: { project: 'viewer' } } },
      { check: { as: 'support', permission: 'project:settings', resource: P1 }, expect: { allowed: false, reason: { code: 'role_too_low', ladder: 'project', role: 'viewer', needed: 'maintainer' } } },
      { check: { as: 'support', permission: 'project:read', resource: P2 }, expect: NO_ACCESS },
      { check: { as: 'support', permission: 'org:manage', resource: O1 }, expect: NO_ACCESS },
    ],
  },
];

export const B45 = fixture('B45', [
  {
    name: 'rbac',
    facets: ['engine', 'rbac', 'ladders'],
    lanes: ['C3'],
    note: 'C3 acceptance (instance admin without org rights). "Support access is only through impersonation under B26" is B26.impersonation; that an app config adds no scoped grant or implies to an instance role is a property of the config (K1 checks the canvas config).',
    world,
    cases,
  },
]);
