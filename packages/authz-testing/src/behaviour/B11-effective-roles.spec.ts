import { GLOBAL } from '@spinajs/authz';

import { servicePrincipal, userPrincipal } from '../principals.js';
import { assignment, combine, fixture, later, ref, role } from './dsl.js';
import type { Case, World } from './types.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const O1 = ref('org', 'o1');
const O2 = ref('org', 'o2');
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const f1 = ref('file', 'f1');
const f2 = ref('file', 'f2');

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const dave = userPrincipal('dave');
const svc = servicePrincipal('svc', { companions: [alice] });

const TYPES = ['file', 'project', 'org'];

const world: World = {
  now: NOW,
  permissions: ['file:read', 'file:write', 'file:delete'].map((name) => ({ name, types: TYPES })),
  principals: { alice, bob, carol, dave, svc },
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
    roles: [role('reader', ['file:read']), role('writer', ['file:write']), role('deleter', ['file:delete'])],
    assignments: [assignment('a1', alice, 'reader', GLOBAL), assignment('a2', alice, 'writer', P1), assignment('a3', alice, 'deleter', O1), assignment('b1', bob, 'writer', P2), assignment('c1', carol, 'writer', GLOBAL, { expiresAt: later(NOW, -1_000) }), assignment('c2', carol, 'reader', P1, { expiresAt: later(NOW, 3_600_000) })],
  },
};

const ALLOWED = { allowed: true } as const;
const NO_ACCESS = { allowed: false, reason: 'no_access' } as const;

const cases: Case[] = [
  {
    name: 'an assignment at GLOBAL applies to every resource',
    steps: [
      { check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: ALLOWED },
      { check: { as: 'alice', permission: 'file:read', resource: f2 }, expect: ALLOWED },
      { check: { as: 'alice', permission: 'file:read', resource: O2 }, expect: ALLOWED },
    ],
  },
  {
    name: 'an assignment at an ancestor of the resource applies to it',
    steps: [
      { check: { as: 'alice', permission: 'file:write', resource: f1 }, expect: ALLOWED },
      { check: { as: 'alice', permission: 'file:delete', resource: f1 }, expect: ALLOWED },
      { check: { as: 'alice', permission: 'file:delete', resource: P1 }, expect: ALLOWED },
    ],
  },
  {
    name: 'an assignment at a scope that is not an ancestor of the resource does not apply',
    steps: [
      { check: { as: 'alice', permission: 'file:write', resource: f2 }, expect: NO_ACCESS },
      { check: { as: 'alice', permission: 'file:delete', resource: f2 }, expect: NO_ACCESS },
      { check: { as: 'bob', permission: 'file:write', resource: f1 }, expect: NO_ACCESS },
      { check: { as: 'bob', permission: 'file:write', resource: f2 }, expect: ALLOWED },
    ],
  },
  {
    name: 'the permissions are the union of the grants of every effective role (H1)',
    steps: [{ checkMany: { as: 'alice', permissions: ['file:read', 'file:write', 'file:delete'], resource: f1 }, expect: { 'file:read': ALLOWED, 'file:write': ALLOWED, 'file:delete': ALLOWED } }],
  },
  {
    name: 'only live assignments are effective: an expired one is not',
    steps: [
      { check: { as: 'carol', permission: 'file:write', resource: f1 }, expect: NO_ACCESS },
      { check: { as: 'carol', permission: 'file:read', resource: f1 }, expect: ALLOWED },
    ],
  },
  {
    name: 'a principal without assignments holds no role',
    steps: [{ checkMany: { as: 'dave', permissions: ['file:read', 'file:write'], resource: f1 }, expect: { 'file:read': NO_ACCESS, 'file:write': NO_ACCESS } }],
  },
  {
    name: "a companion's assignments are among the principal's subjects",
    steps: [
      { check: { as: 'svc', permission: 'file:read', resource: f2 }, expect: ALLOWED },
      { check: { as: 'svc', permission: 'file:write', resource: f1 }, expect: ALLOWED },
      { check: { as: 'svc', permission: 'file:write', resource: f2 }, expect: NO_ACCESS },
    ],
  },
];

export const B11 = fixture('B11', [
  {
    name: 'rbac',
    facets: ['engine', 'rbac'],
    lanes: ['L1'],
    note: 'Subjects here are the principal and its companions (L1 task 11); subject sets are B33.',
    world,
    cases,
  },
]);
