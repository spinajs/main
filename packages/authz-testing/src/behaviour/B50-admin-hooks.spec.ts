import type { ResourceRef } from '@spinajs/authz';
import type { TestAdminCommand as AuthzCommand } from '../model-shapes.js';

import { userPrincipal } from '../principals.js';
import { assignment, combine, fixture, ref, role } from './dsl.js';
import { exec } from './model-steps.js';
import type { Via } from './model-steps.js';
import type { Case, DecisionExpectation, World } from './types.js';

const O1 = ref('org', 'o1');
const P1 = ref('project', 'p1');
const f1 = ref('file', 'f1');

const TYPES = ['org', 'project', 'file'];
const MANAGE = ['authz:assignments.manage', 'authz:links.manage'];

const alice = userPrincipal('alice');
const root = userPrincipal('root');

const READS: DecisionExpectation = { allowed: true };
const NO_READ: DecisionExpectation = { allowed: false };
const aliceReads = (expect: DecisionExpectation) => ({ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect });

const grant = (roleName: string, scope: ResourceRef = P1): AuthzCommand => ({ kind: 'assignment.grant', subject: { type: 'user', id: 'alice' }, role: roleName, scope });

// `viewer` is refused by the hook, `reader` is the same role under another name.
const world = (extra: Partial<World> = {}): World => ({
  permissions: ['file:read', ...MANAGE].map((name) => ({ name, types: TYPES })),
  principals: { alice, root },
  scopes: [{ nodes: [{ ref: P1, parent: O1 }, { ref: f1, parent: P1 }] }],
  combine: combine('deny-overrides', 'rbac'),
  rbac: { roles: [role('viewer', ['file:read']), role('reader', ['file:read']), role('superuser', [...MANAGE, 'file:read'])], assignments: [assignment('r1', root, 'superuser', ref('org', 'o1'))] },
  hooks: [{ action: 'authz.admin.command', refuse: 'viewer-frozen', when: { role: 'viewer' } }],
  ...extra,
});

const cases = (via: Via): Case[] => [
  {
    name: 'an authz.admin.command refusal fails the command with hook:<code> and nothing is written',
    world: world(),
    steps: [exec('root', [grant('viewer')], { failsAt: 0, code: 'hook:viewer-frozen' }, { via }), aliceReads(NO_READ)],
  },
  {
    name: 'the batch stops at the refused command: the commands before it are not applied either',
    world: world(),
    steps: [exec('root', [grant('reader'), grant('viewer')], { failsAt: 1, code: 'hook:viewer-frozen' }, { via }), aliceReads(NO_READ)],
  },
  {
    name: 'a command the hook does not match is applied',
    world: world(),
    steps: [exec('root', [grant('reader')], 'ok', { via }), aliceReads(READS)],
  },
];

export const B50 = fixture('B50', [
  {
    name: 'admin',
    facets: ['engine', 'rbac', 'admin', 'hooks'],
    lanes: ['L9'],
    note: 'The hook refusal through AuthzAdmin.execute; world.hooks registers the hooks in the domain container. The batch and mutation cases are in authz/test/hooks.',
    cases: cases('admin'),
  },
  {
    name: 'http',
    facets: ['http', 'engine', 'rbac', 'hooks'],
    lanes: ['C4'],
    note: 'The same cases through POST /authz/commands: the refused answer is the admin failure body with code hook:<code>.',
    cases: cases('http'),
  },
]);
