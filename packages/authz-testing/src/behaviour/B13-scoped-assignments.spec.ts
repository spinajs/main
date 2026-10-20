import { GLOBAL } from '@spinajs/authz';
import type { AuthzCommand, ResourceRef } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { assignment, combine, fixture, ref, role } from './dsl.js';
import { exec } from './model-steps.js';
import type { Via } from './model-steps.js';
import type { Case, DecisionExpectation, World } from './types.js';

const O1 = ref('org', 'o1');
const O2 = ref('org', 'o2');
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const P3 = ref('project', 'p3');
const f1 = ref('file', 'f1');
const f2 = ref('file', 'f2');
const f3 = ref('file', 'f3');

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const root = userPrincipal('root');

const TYPES = ['org', 'project', 'file'];

// o1 → p1 → f1, o1 → p2 → f2, o2 → p3 → f3.
const world = (assignments: NonNullable<World['rbac']>['assignments'] = []): World => ({
  permissions: ['project:update', 'file:edit', 'org:manage', 'authz:assignments.manage'].map((name) => ({ name, types: TYPES })),
  principals: { alice, bob, carol, root },
  scopes: [
    {
      nodes: [
        { ref: P1, parent: O1 },
        { ref: f1, parent: P1 },
        { ref: P2, parent: O1 },
        { ref: f2, parent: P2 },
        { ref: P3, parent: O2 },
        { ref: f3, parent: P3 },
      ],
    },
  ],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('editor', ['project:update', 'file:edit']), role('org.admin', ['org:manage', 'project:update', 'file:edit'], { scopeTypes: ['org'] }), role('superuser', ['authz:assignments.manage', 'org:manage', 'project:update', 'file:edit'])],
    assignments: [...assignments, assignment('r1', root, 'superuser', GLOBAL)],
  },
});

const ALLOWED: DecisionExpectation = { allowed: true };
const NO_ACCESS: DecisionExpectation = { allowed: false, reason: 'no_access' };
const on = (as: string, permission: string, resource: ResourceRef, expect: DecisionExpectation) => ({ check: { as, permission, resource }, expect });

const scoped = world([assignment('a1', alice, 'editor', P1), assignment('a2', alice, 'org.admin', O1), assignment('b1', bob, 'org.admin', O2)]);

const rbacCases: Case[] = [
  { name: 'an assignment at S applies to S', world: scoped, steps: [on('alice', 'project:update', P1, ALLOWED)] },
  { name: 'an assignment at S applies to the descendants of S', world: scoped, steps: [on('alice', 'file:edit', f1, ALLOWED), on('alice', 'file:edit', f2, ALLOWED), on('alice', 'org:manage', O1, ALLOWED)] },
  {
    name: 'an assignment at S does not apply to an ancestor of S',
    world: world([assignment('a1', alice, 'editor', P1)]),
    steps: [on('alice', 'project:update', O1, NO_ACCESS)],
  },
  {
    name: 'an assignment at S does not apply to a sibling of S or its descendants',
    world: world([assignment('a1', alice, 'editor', P1)]),
    steps: [on('alice', 'project:update', P2, NO_ACCESS), on('alice', 'file:edit', f2, NO_ACCESS), on('alice', 'file:edit', f3, NO_ACCESS)],
  },
  {
    name: 'role definitions are global: one role means the same at every scope (H14)',
    world: scoped,
    steps: [on('alice', 'file:edit', f2, ALLOWED), on('alice', 'file:edit', f3, NO_ACCESS), on('bob', 'file:edit', f3, ALLOWED), on('bob', 'org:manage', O2, ALLOWED), on('bob', 'file:edit', f1, NO_ACCESS), on('bob', 'org:manage', O1, NO_ACCESS)],
  },
];

const grant = (roleName: string, scope: ResourceRef, id = 'carol'): AuthzCommand => ({ kind: 'assignment.grant', subject: { type: 'user', id }, role: roleName, scope });

const writeCases = (via: Via): Case[] => [
  {
    name: 'a role with scopeTypes cannot be assigned at another scope type (wrong_scope_type)',
    world: world(),
    steps: [exec('root', [grant('org.admin', P1)], { failsAt: 0, code: 'wrong_scope_type' }, { via }), on('carol', 'file:edit', f1, NO_ACCESS)],
  },
  {
    name: 'a role with scopeTypes is assigned at a scope of that type and applies below it',
    world: world(),
    steps: [exec('root', [grant('org.admin', O1)], 'ok', { via }), on('carol', 'file:edit', f1, ALLOWED), on('carol', 'file:edit', f3, NO_ACCESS)],
  },
  {
    name: 'a role without scopeTypes is assigned at any scope',
    world: world(),
    steps: [exec('root', [grant('editor', f1)], 'ok', { via }), on('carol', 'file:edit', f1, ALLOWED), on('carol', 'project:update', P1, NO_ACCESS)],
  },
];

export const B13 = fixture('B13', [
  { name: 'rbac', facets: ['engine', 'rbac'], lanes: ['L1'], note: 'Ancestors come from the kit scope resolver (o1 → p1 → f1, o1 → p2 → f2, o2 → p3 → f3).', cases: rbacCases },
  { name: 'write', facets: ['engine', 'rbac', 'admin'], lanes: ['L2', 'L9'], note: 'scopeTypes are checked when AuthzAdmin validates assignment.grant (design §6.6.2). The actor root may manage assignments everywhere and covers both roles.', cases: writeCases('admin') },
  { name: 'http', facets: ['http', 'engine', 'rbac'], lanes: ['C4'], note: 'The write cases through POST /authz/commands (lane handle adminHttp): "B13 via API".', cases: writeCases('http') },
]);
