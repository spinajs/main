import { GLOBAL } from '@spinajs/authz';
import type { AuthzCommand } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { assignment, combine, fixture, ref, role } from './dsl.js';
import { exec, storedAssignment } from './model-steps.js';
import type { Via } from './model-steps.js';
import type { Case, Throws, World } from './types.js';

const O1 = ref('org', 'o1');
const P1 = ref('project', 'p1');
const f1 = ref('file', 'f1');

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const root = userPrincipal('root');

const CONFIG: Throws = { throws: 'AuthzConfigError' };

// admin extends the non-assignable package admin.users; c extends b extends a.
const ROLES = [role('admin.users', ['users:read'], { assignable: false }), role('admin', ['user:impersonate'], { extends: ['admin.users'] }), role('a', ['doc:read']), role('b', ['doc:write'], { extends: ['a'] }), role('c', [], { extends: ['b'] })];

const world = (rbac: World['rbac']): World => ({
  permissions: ['users:read', 'user:impersonate', 'doc:read', 'doc:write', 'authz:assignments.manage'],
  principals: { alice, bob, carol, root },
  combine: combine('deny-overrides', 'rbac'),
  rbac,
});

const base = world({ roles: ROLES, assignments: [assignment('a1', alice, 'admin'), assignment('b1', bob, 'c')] });

const refused = (name: string, rbac: World['rbac']): Case => ({ name, world: world(rbac), boot: CONFIG, steps: [] });

const rbacCases: Case[] = [
  {
    name: 'extends inherits the grants of the extended role',
    world: base,
    steps: [
      { check: { as: 'alice', permission: 'user:impersonate' }, expect: { allowed: true } },
      { check: { as: 'alice', permission: 'users:read' }, expect: { allowed: true } },
    ],
  },
  {
    name: 'extends is transitive',
    world: base,
    steps: [{ checkMany: { as: 'bob', permissions: ['doc:read', 'doc:write'] }, expect: { 'doc:read': { allowed: true }, 'doc:write': { allowed: true } } }],
  },
  {
    name: 'a role that is not assignable still passes its grants on through extends',
    world: base,
    steps: [{ check: { as: 'alice', permission: 'users:read' }, expect: { allowed: true, residual: 'TRUE' } }],
  },
  refused('a cycle of two roles is refused at boot', { roles: [role('a', ['doc:read'], { extends: ['b'] }), role('b', [], { extends: ['a'] })] }),
  refused('a role that extends itself is refused at boot', { roles: [role('a', ['doc:read'], { extends: ['a'] })] }),
  refused('a longer cycle is refused at boot', { roles: [role('a', [], { extends: ['c'] }), role('b', [], { extends: ['a'] }), role('c', ['doc:read'], { extends: ['b'] })] }),
  refused('extends naming an unknown role is refused at boot', { roles: [role('a', ['doc:read'], { extends: ['ghost'] })] }),
];

const impliesWorld: World = {
  permissions: [{ name: 'project:settings', types: ['org', 'project', 'file'] }],
  principals: { alice, bob },
  scopes: [
    {
      nodes: [
        { ref: P1, parent: O1 },
        { ref: f1, parent: P1 },
      ],
    },
  ],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('maintainer', ['project:settings']), role('org.admin', [], { implies: [{ role: 'maintainer', at: 'self-and-descendants' }] }), role('org.owner', [], { extends: ['org.admin'] }), role('org.root', [], { extends: ['org.owner'] })],
    assignments: [assignment('a1', alice, 'org.owner', O1), assignment('b1', bob, 'org.root', O1)],
  },
};

const ghost: AuthzCommand = { kind: 'assignment.grant', subject: { type: 'user', id: 'alice' }, role: 'ghost', scope: GLOBAL };
const grant = (roleName: string, id = 'alice'): AuthzCommand => ({ kind: 'assignment.grant', subject: { type: 'user', id }, role: roleName, scope: GLOBAL });

// root may manage assignments and covers every role it grants, so only validation can refuse its writes.
const writeWorld = world({ roles: [...ROLES, role('superuser', ['authz:assignments.manage', 'users:read', 'user:impersonate', 'doc:read', 'doc:write'])], assignments: [assignment('r1', root, 'superuser')] });

const writeCases = (via: Via): Case[] => [
  {
    name: 'a write naming an unknown role is refused (unknown_role)',
    world: writeWorld,
    steps: [exec('root', [ghost], { failsAt: 0, code: 'unknown_role' }, { via })],
  },
  {
    name: 'a write assigning a role that is not assignable is refused (not_assignable)',
    world: writeWorld,
    steps: [exec('root', [grant('admin.users')], { failsAt: 0, code: 'not_assignable' }, { via }), { check: { as: 'alice', permission: 'users:read' }, expect: { allowed: false } }],
  },
  {
    name: 'a write assigning a role that extends a non-assignable one is accepted and inherits its grants',
    world: writeWorld,
    steps: [exec('root', [grant('admin')], 'ok', { via }), { check: { as: 'alice', permission: 'users:read' }, expect: { allowed: true } }],
  },
  {
    name: 'one refused command refuses the whole batch',
    world: writeWorld,
    steps: [exec('root', [grant('c', 'bob'), ghost], { failsAt: 1, code: 'unknown_role' }, { via }), { check: { as: 'bob', permission: 'doc:read' }, expect: { allowed: false } }],
  },
];

const storeCases: Case[] = [
  {
    name: 'an unknown role on a stored assignment is ignored, and the other assignments still count',
    world: world({ roles: ROLES, assignments: [assignment('a1', alice, 'a')] }),
    steps: [storedAssignment(assignment('g1', alice, 'ghost')), storedAssignment(assignment('g2', carol, 'ghost')), { check: { as: 'alice', permission: 'doc:read' }, expect: { allowed: true } }, { check: { as: 'carol', permission: 'doc:read' }, expect: { allowed: false, reason: 'no_access' } }],
  },
];

export const B12 = fixture('B12', [
  {
    name: 'rbac',
    facets: ['engine', 'rbac'],
    lanes: ['L1'],
    note: 'Config errors are boot cases: the RBAC model refuses the role graph when it compiles. The config side of "assignable: false targets of an assignment" (which config keys assign roles: defaultRoles, anonymousRoles, serviceRoles) is not specified by §6.1/§8.2; L1 proposes it by RFC.',
    cases: rbacCases,
  },
  {
    name: 'implies',
    facets: ['engine', 'rbac', 'ladders'],
    lanes: ['L1b'],
    note: 'extends passes implies on transitively; implies naming an unknown role is a boot error (design §6.5 rule 9). implies is L1b (task 3); its runBehaviour list lacks B12, so L1b should add B12.implies.',
    world: impliesWorld,
    cases: [
      {
        name: 'a role that extends an implying role implies its role too, transitively',
        steps: [
          { check: { as: 'alice', permission: 'project:settings', resource: f1 }, expect: { allowed: true } },
          { check: { as: 'bob', permission: 'project:settings', resource: P1 }, expect: { allowed: true } },
        ],
      },
      {
        name: 'implies naming an unknown role is refused at boot',
        world: { ...impliesWorld, rbac: { roles: [role('maintainer', ['project:settings']), role('org.admin', [], { implies: [{ role: 'ghost', at: 'self-and-descendants' }] })] } },
        boot: CONFIG,
        steps: [],
      },
    ],
  },
  {
    name: 'write',
    facets: ['engine', 'rbac', 'admin'],
    lanes: ['L2', 'L9', 'C1'],
    note: 'The write path is AuthzAdmin (design §6.6.2 validate). B12 says InvalidArgument for writes, while §6.6.1 reports AuthzAdminError codes (unknown_role, not_assignable) and the sugar methods throw AuthzAdminFailure: the cases assert the codes only.',
    cases: writeCases('admin'),
  },
  {
    name: 'http',
    facets: ['http', 'engine', 'rbac'],
    lanes: ['C4'],
    note: 'The write cases through POST /authz/commands (lane handle adminHttp).',
    cases: writeCases('http'),
  },
  {
    name: 'store',
    facets: ['engine', 'rbac', 'store'],
    lanes: ['L2'],
    note: 'A stored row whose role is unknown (written before the role left the config) is planted through the lane handle rbacStore. Only L2 has the store facet, so L1 covers "ignored" in its own model test with an in-memory AssignmentStore holding such a row. The warning it logs is not observable through the kit; L2 asserts it in its own test.',
    cases: storeCases,
  },
]);
