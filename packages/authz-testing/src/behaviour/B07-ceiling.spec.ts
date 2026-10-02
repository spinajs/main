import { userPrincipal, withCeiling } from '../principals.js';
import { assignment, combine, fixture, later, permit, ref, role, staticModel } from './dsl.js';
import type { Case, DecisionExpectation, World } from './types.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const HOUR = 3_600_000;
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const f1 = ref('file', 'f1');
const f2 = ref('file', 'f2');

const alice = userPrincipal('alice');
const principals = {
  readOnly: withCeiling(alice, { permissions: ['file:read'] }),
  fileGlob: withCeiling(alice, { permissions: ['file:*'] }),
  inP1: withCeiling(alice, { resources: [P1] }),
  nowhere: withCeiling(alice, { resources: [] }),
  expiresLater: withCeiling(alice, { expiresAt: later(NOW, HOUR) }),
  expiresNow: withCeiling(alice, { expiresAt: NOW }),
  expired: withCeiling(alice, { expiresAt: later(NOW, -1) }),
  outOfScope: withCeiling(alice, { permissions: ['file:read'], reason: 'out_of_scope' }),
  rolesOnly: withCeiling(alice, { roles: ['viewer'] }),
};

const world = (models: World['models'] = [staticModel('m1', { votes: { '*': permit() } })]): World => ({
  now: NOW,
  permissions: ['file:read', 'file:write'],
  principals,
  scopes: [
    {
      nodes: [
        { ref: f1, parent: P1 },
        { ref: f2, parent: P2 },
      ],
    },
  ],
  combine: combine('deny-overrides', 'm1'),
  models,
});

const CEILING: DecisionExpectation = { allowed: false, reason: 'ceiling', residual: 'FALSE' };
const ALLOWED: DecisionExpectation = { allowed: true };

const check = (name: string, as: keyof typeof principals, permission: string, resource: typeof f1, expect: DecisionExpectation, w = world()): Case => ({
  name,
  world: w,
  steps: [{ check: { as, permission, resource }, expect }],
});

const core: Case[] = [
  check('a permission outside ceiling.permissions is denied with reason ceiling, over an unconditional permit', 'readOnly', 'file:write', f1, CEILING),
  check('a permission the ceiling covers keeps the models answer', 'readOnly', 'file:read', f1, ALLOWED),
  check('ceiling.permissions are globs', 'fileGlob', 'file:write', f1, ALLOWED),
  check('a resource under ceiling.resources keeps the models answer', 'inP1', 'file:read', f1, ALLOWED),
  check('a resource outside ceiling.resources is denied', 'inP1', 'file:read', f2, CEILING),
  check('ceiling.resources [] covers nothing', 'nowhere', 'file:read', f1, CEILING),
  check('before expiresAt the ceiling holds', 'expiresLater', 'file:read', f1, ALLOWED),
  check('at expiresAt (now ≥ expiresAt) the ceiling denies', 'expiresNow', 'file:read', f1, CEILING),
  check('after expiresAt the ceiling denies', 'expired', 'file:read', f1, CEILING),
  check('ceiling.reason replaces the code', 'outOfScope', 'file:write', f1, { allowed: false, reason: 'out_of_scope' }),
  check('a ceiling never adds access: inside it, no permit still gives no_access', 'readOnly', 'file:read', f1, { allowed: false, reason: 'no_access' }, world([staticModel('m1')])),
  check('ceiling.roles alone does not deny in the core: roles are filtered by the models', 'rolesOnly', 'file:write', f1, ALLOWED),
  {
    name: 'a filter for a permission outside the ceiling is FALSE',
    world: world(),
    steps: [{ filter: { as: 'readOnly', permission: 'file:write', type: 'file' }, expect: 'FALSE' }],
  },
];

const bob = userPrincipal('bob');
const rbacWorld: World = {
  permissions: ['file:read', 'file:write'],
  principals: { alice: withCeiling(alice, { roles: ['viewer'] }), bob: withCeiling(bob, { permissions: ['file:read'] }) },
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('viewer', ['file:read']), role('editor', ['file:read', 'file:write']), role('admin', ['file:*'])],
    assignments: [assignment('a1', alice, 'viewer'), assignment('a2', alice, 'editor'), assignment('a3', bob, 'admin')],
  },
};

export const B07 = fixture('B07', [
  { name: 'core', facets: ['engine'], lanes: ['F3'], cases: core },
  {
    name: 'rbac',
    facets: ['engine', 'rbac'],
    lanes: ['L1'],
    world: rbacWorld,
    cases: [
      {
        name: 'ceiling.roles removes the RBAC roles it does not list',
        steps: [
          { check: { as: 'alice', permission: 'file:write', resource: f1 }, expect: { allowed: false, reason: 'no_access' } },
          { check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: ALLOWED },
        ],
      },
      {
        name: 'no role bypasses the ceiling',
        steps: [
          { check: { as: 'bob', permission: 'file:write', resource: f1 }, expect: CEILING },
          { check: { as: 'bob', permission: 'file:read', resource: f1 }, expect: ALLOWED },
        ],
      },
    ],
  },
  { name: 'token', facets: ['token'], lanes: ['C5'], note: "Token-derived ceilings (token roles ∩ owner's roles, Scope) need authn token issuance; C5 proposes the cases by RFC.", cases: [] },
]);
