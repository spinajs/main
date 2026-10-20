import { userPrincipal } from '../principals.js';
import { ALGORITHMS, assignment, combine, deny, fixture, permit, ref, role, staticModel } from './dsl.js';
import type { Case, DecisionExpectation, World } from './types.js';

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const permissions = ['file:read', 'file:write', 'project:read'];
const f1 = ref('file', 'f1');

const NO_ACCESS: DecisionExpectation = { allowed: false, reason: 'no_access', residual: 'FALSE' };

const kit = (world: Omit<World, 'permissions' | 'principals'>): World => ({ permissions, principals: { alice }, ...world });

const core: Case[] = [
  ...ALGORITHMS.flatMap((algorithm): Case[] => [
    {
      name: `${algorithm}: no routed model has an opinion`,
      world: kit({ combine: combine(algorithm, 'm1', 'm2'), models: [staticModel('m1'), staticModel('m2')] }),
      steps: [
        { check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: NO_ACCESS },
        { check: { as: 'alice', permission: 'file:read' }, expect: NO_ACCESS },
      ],
    },
    {
      name: `${algorithm}: a permit of another permission does not count`,
      world: kit({ combine: combine(algorithm, 'm1'), models: [staticModel('m1', { votes: { 'file:write': permit() } })] }),
      steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: NO_ACCESS }],
    },
  ]),
  {
    name: 'no model is routed: the combine route names none',
    world: kit({ combine: combine('deny-overrides'), models: [staticModel('m1', { votes: { '*': permit() } })] }),
    steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: NO_ACCESS }],
  },
  {
    name: 'a model that does not apply to the permission is not routed',
    world: kit({ combine: combine('deny-overrides', 'm1'), models: [staticModel('m1', { applies: { permissions: ['project:*'] }, votes: { '*': permit() } })] }),
    steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: NO_ACCESS }, { calls: { model: 'm1', count: 0 } }],
  },
  {
    name: 'a bare deny without a reason gives no_access',
    world: kit({ combine: combine('deny-overrides', 'm1'), models: [staticModel('m1', { votes: { 'file:read': deny() } })] }),
    steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: NO_ACCESS }],
  },
  {
    name: 'control: a routed permit is allowed',
    world: kit({ combine: combine('deny-overrides', 'm1'), models: [staticModel('m1', { votes: { 'file:read': permit() } })] }),
    steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: true, residual: 'TRUE', reason: null } }],
  },
];

const rbacWorld: World = {
  permissions,
  principals: { alice, bob },
  combine: combine('deny-overrides', 'rbac'),
  rbac: { roles: [role('viewer', ['file:read'])], assignments: [assignment('a1', bob, 'viewer')] },
};

export const B01 = fixture('B01', [
  { name: 'core', facets: ['engine'], lanes: ['F3'], cases: core },
  {
    name: 'rbac',
    facets: ['engine', 'rbac'],
    lanes: ['L1'],
    world: rbacWorld,
    cases: [
      { name: 'a principal without assignments gets no_access', steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: NO_ACCESS }] },
      { name: 'a role without the permission gives no_access', steps: [{ check: { as: 'bob', permission: 'file:write', resource: f1 }, expect: NO_ACCESS }] },
      { name: 'control: the granted permission is allowed', steps: [{ check: { as: 'bob', permission: 'file:read', resource: f1 }, expect: { allowed: true } }] },
    ],
  },
]);
