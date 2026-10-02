import { GLOBAL } from '@spinajs/authz';
import type { RuleDef } from '@spinajs/authz';

import { userPrincipal, withCeiling } from '../principals.js';
import { assignment, combine, fixture, ref, role } from './dsl.js';
import type { Case, DecisionExpectation, World } from './types.js';

const O1 = ref('org', 'o1');
const O2 = ref('org', 'o2');
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const f1 = ref('file', 'f1');

const TYPES = ['org', 'project', 'file'];

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const dave = userPrincipal('dave');
const principals = { alice, bob, carol, dave, aliceCapped: withCeiling(alice, { permissions: ['file:read'] }), aliceAsViewer: withCeiling(alice, { roles: ['viewer'] }) };

// org.admin (no ladder) implies maintainer with the code tag, exempt from restrict and cap; org.lead
// implies editor below its scope only.
const ROLES = [role('viewer', ['file:read'], { ladder: 'project' }), role('editor', ['file:edit'], { ladder: 'project' }), role('maintainer', ['project:settings', { permission: 'code:view', requiresTag: 'code' }], { ladder: 'project' }), role('org.admin', ['project:archive'], { implies: [{ role: 'maintainer', at: 'self-and-descendants', tags: ['code'], bypass: ['restrict', 'cap'] }] }), role('org.lead', [], { implies: [{ role: 'editor', at: 'descendants' }] })];

const world = (rules: readonly RuleDef[] = []): World => ({
  permissions: ['file:read', 'file:edit', 'project:settings', 'code:view', 'project:archive'].map((name) => ({ name, types: TYPES })),
  principals,
  scopes: [
    {
      nodes: [
        { ref: P1, parent: O1 },
        { ref: f1, parent: P1 },
        { ref: P2, parent: O2 },
      ],
    },
  ],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    ladders: [{ name: 'project', roles: ['viewer', 'editor', 'maintainer'] }],
    roles: ROLES,
    rules,
    assignments: [assignment('a1', alice, 'org.admin', O1), assignment('b1', bob, 'org.lead', O1), assignment('c1', carol, 'maintainer', P1), assignment('d1', dave, 'editor', O1)],
  },
});

const ALLOWED: DecisionExpectation = { allowed: true };
const NO_ACCESS: DecisionExpectation = { allowed: false, reason: 'no_access' };
const base = world();

const ladderCases: Case[] = [
  {
    name: 'implies adds the implied role at the scope and below',
    world: base,
    steps: [
      { check: { as: 'alice', permission: 'project:settings', resource: P1 }, expect: { allowed: true, roles: { project: 'maintainer' } } },
      { check: { as: 'alice', permission: 'file:edit', resource: f1 }, expect: ALLOWED },
    ],
  },
  {
    name: 'the implied role carries the tags implies declares',
    world: base,
    steps: [
      { check: { as: 'alice', permission: 'code:view', resource: P1 }, expect: ALLOWED },
      { check: { as: 'carol', permission: 'code:view', resource: P1 }, expect: { allowed: false, reason: { code: 'tag_missing', tag: 'code' } } },
    ],
  },
  { name: "at: 'self-and-descendants' includes the scope itself", world: base, steps: [{ check: { as: 'alice', permission: 'project:settings', resource: O1 }, expect: ALLOWED }] },
  {
    name: "at: 'descendants' leaves the scope itself out",
    world: base,
    steps: [
      { check: { as: 'bob', permission: 'file:edit', resource: f1 }, expect: ALLOWED },
      { check: { as: 'bob', permission: 'file:edit', resource: O1 }, expect: NO_ACCESS },
    ],
  },
  {
    name: 'nothing is implied outside the scope of the implying assignment',
    world: base,
    steps: [
      { check: { as: 'alice', permission: 'project:settings', resource: P2 }, expect: NO_ACCESS },
      { check: { as: 'bob', permission: 'file:edit', resource: P2 }, expect: NO_ACCESS },
    ],
  },
  {
    name: 'bypass never exempts from the ceiling',
    world: base,
    steps: [
      { check: { as: 'aliceCapped', permission: 'project:settings', resource: P1 }, expect: { allowed: false, reason: 'ceiling' } },
      { check: { as: 'aliceCapped', permission: 'file:read', resource: f1 }, expect: ALLOWED },
    ],
  },
  {
    name: 'ceiling.roles without the implying role drops what it implies (bypass included)',
    world: base,
    steps: [
      { check: { as: 'aliceAsViewer', permission: 'project:settings', resource: P1 }, expect: { allowed: false } },
      { check: { as: 'aliceAsViewer', permission: 'code:view', resource: P1 }, expect: { allowed: false } },
    ],
  },
];

const RESTRICT_P1: RuleDef = { id: 'restrict-p1', kind: 'restrict', scope: P1, allow: [], source: 'test' };
const CAP_ALL: RuleDef = { id: 'cap-all', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', source: 'test' };

const rulesCases: Case[] = [
  {
    name: 'bypass restrict keeps the implied contribution of an assignment made above the restricted node',
    world: world([RESTRICT_P1]),
    steps: [
      { check: { as: 'alice', permission: 'project:settings', resource: P1 }, expect: ALLOWED },
      { check: { as: 'dave', permission: 'file:edit', resource: f1 }, expect: NO_ACCESS },
    ],
  },
  {
    name: "bypass exempts only the implied contribution, not the implying role's own grants",
    world: world([RESTRICT_P1]),
    steps: [
      { check: { as: 'alice', permission: 'project:archive', resource: P1 }, expect: NO_ACCESS },
      { check: { as: 'alice', permission: 'project:archive', resource: O1 }, expect: ALLOWED },
    ],
  },
  {
    name: 'bypass cap keeps the rank of the implied contribution',
    world: world([CAP_ALL]),
    steps: [
      { check: { as: 'alice', permission: 'project:settings', resource: P1 }, expect: { allowed: true, roles: { project: 'maintainer' } } },
      { check: { as: 'carol', permission: 'project:settings', resource: P1 }, expect: { allowed: false, reason: { code: 'role_too_low', ladder: 'project', role: 'viewer', needed: 'maintainer' } } },
    ],
  },
];

export const B32 = fixture('B32', [
  { name: 'ladders', facets: ['engine', 'rbac', 'ladders'], lanes: ['L1b'], cases: ladderCases },
  { name: 'rules', facets: ['engine', 'rbac', 'ladders', 'rules'], lanes: ['L1b'], note: 'bypass: [restrict, cap] on the implied maintainer of org.admin (design §8.5).', cases: rulesCases },
]);
