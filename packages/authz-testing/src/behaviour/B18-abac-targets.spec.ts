import type { Policy } from '@spinajs/authz';

import { agentPrincipal, servicePrincipal, userPrincipal } from '../principals.js';
import { combine, fixture, ref } from './dsl.js';
import type { Case, FakeRbacSpec, World } from './types.js';

const O1 = ref('org', 'o1');
const O2 = ref('org', 'o2');
const f1 = ref('file', 'f1');
const f2 = ref('file', 'f2');
const d1 = ref('folder', 'd1');

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const svc = servicePrincipal('svc');
const bot = servicePrincipal('bot', { companions: [bob] });
const agent = agentPrincipal('ag1', alice);

const TYPES = ['file', 'folder'];

// The kit FakeRbacModel (named rbac) gives alice file:* everywhere; everybody else holds nothing there.
const RBAC: FakeRbacSpec = { kind: 'fake-rbac', roles: { editor: ['file:*'] }, assignments: [{ subject: alice, role: 'editor' }] };

const world = (policies: readonly Omit<Policy, 'source'>[]): World => ({
  permissions: [...['file:read', 'file:write', 'file:delete'].map((name) => ({ name, types: TYPES })), 'note:read'],
  principals: { alice, bob, svc, bot, agent },
  scopes: [
    {
      nodes: [
        { ref: f1, parent: O1 },
        { ref: d1, parent: O1 },
        { ref: f2, parent: O2 },
      ],
    },
  ],
  combine: combine('deny-overrides', 'rbac', 'abac'),
  models: [RBAC],
  abac: { policies: policies.map((p) => ({ ...p, source: 'test' })) },
});

const read = (as: string, resource = f1, permission = 'file:read') => ({ check: { as, permission, resource } });

const cases: Case[] = [
  {
    name: 'an ABAC deny policy beats an RBAC permit under deny-overrides',
    world: world([{ id: 'no-delete', effect: 'deny', permissions: ['file:delete'], reason: 'no_delete' }]),
    steps: [
      { ...read('alice', f1, 'file:delete'), expect: { allowed: false, reason: 'no_delete' } },
      { ...read('alice', f1, 'file:read'), expect: { allowed: true } },
    ],
  },
  {
    name: 'an ABAC permit policy grants on its own',
    world: world([{ id: 'read-all', effect: 'permit', permissions: ['file:read'] }]),
    steps: [
      { ...read('bob'), expect: { allowed: true } },
      { ...read('bob', f1, 'file:write'), expect: { allowed: false } },
    ],
  },
  {
    name: 'a policy targets permissions by glob',
    world: world([{ id: 'files', effect: 'permit', permissions: ['file:*'] }]),
    steps: [
      { ...read('bob', f1, 'file:write'), expect: { allowed: true } },
      { check: { as: 'bob', permission: 'note:read', resource: ref('note', 'n1') }, expect: { allowed: false } },
    ],
  },
  {
    name: 'a policy targets resource types',
    world: world([{ id: 'files-only', effect: 'permit', permissions: ['file:read'], resourceTypes: ['file'] }]),
    steps: [
      { ...read('bob', f1), expect: { allowed: true } },
      { ...read('bob', d1), expect: { allowed: false } },
    ],
  },
  {
    name: 'a policy targets principal types',
    world: world([{ id: 'services', effect: 'permit', permissions: ['file:read'], principalTypes: ['service'] }]),
    steps: [
      { ...read('svc'), expect: { allowed: true } },
      { ...read('bob'), expect: { allowed: false } },
    ],
  },
  {
    name: "principal types match the principal's companions too",
    world: world([{ id: 'users', effect: 'permit', permissions: ['file:read'], principalTypes: ['user'] }]),
    steps: [
      { ...read('bot'), expect: { allowed: true } },
      { ...read('svc'), expect: { allowed: false } },
    ],
  },
  {
    name: 'a policy targets actor types (an agent acting for a user under inherit)',
    world: world([{ id: 'agents-off', effect: 'deny', permissions: ['*'], actorTypes: ['agent'], reason: 'agents_disabled', priority: 100 }]),
    steps: [
      { ...read('agent'), expect: { allowed: false, reason: 'agents_disabled' } },
      { ...read('alice'), expect: { allowed: true } },
    ],
  },
  {
    name: 'a policy applies at its scope and below',
    world: world([{ id: 'o1-readers', effect: 'permit', permissions: ['file:read'], scope: O1 }]),
    steps: [
      { ...read('bob', f1), expect: { allowed: true } },
      { ...read('bob', d1), expect: { allowed: true } },
      { ...read('bob', f2), expect: { allowed: false } },
    ],
  },
];

export const B18 = fixture('B18', [
  {
    name: 'abac',
    facets: ['engine', 'abac'],
    lanes: ['L3'],
    note: 'The ABAC model next to the kit FakeRbacModel (named rbac), which grants alice file:* everywhere. Policies without a when need no ConditionCompiler.',
    cases,
  },
]);
