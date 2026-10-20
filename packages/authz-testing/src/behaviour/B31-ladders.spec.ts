import { GLOBAL } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { assignment, combine, fixture, later, ref, role } from './dsl.js';
import type { Case, DecisionExpectation, World } from './types.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const O1 = ref('org', 'o1');
const P1 = ref('project', 'p1');
const f1 = ref('file', 'f1');
const f2 = ref('file', 'f2');

const TYPES = ['org', 'project', 'file'];
const p = (name: string) => ({ name, types: TYPES });

const users = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'hank'] as const;
const principals = Object.fromEntries(users.map((id) => [id, userPrincipal(id)]));
const u = (id: (typeof users)[number]) => principals[id];

// file:edit is granted by editor and again by maintainer, so its needed role is editor, the lowest.
const LADDERS = [
  { name: 'project', roles: ['viewer', 'commenter', 'editor', 'maintainer'], resourceTypes: ['project', 'file'] },
  { name: 'org', roles: ['org.member', 'org.admin'] },
];
const ROLES = [role('viewer', ['file:read'], { ladder: 'project' }), role('commenter', ['file:comment'], { ladder: 'project' }), role('editor', ['file:edit'], { ladder: 'project' }), role('maintainer', ['project:settings', 'file:edit'], { ladder: 'project' }), role('org.member', [], { ladder: 'org' }), role('org.admin', ['org:audit'], { ladder: 'org' })];

const world = (rules: NonNullable<World['rbac']>['rules'] = []): World => ({
  now: NOW,
  permissions: ['file:read', 'file:comment', 'file:edit', 'project:settings', 'org:audit'].map(p),
  principals,
  scopes: [
    {
      nodes: [
        { ref: P1, parent: O1 },
        { ref: f1, parent: P1 },
        { ref: f2, parent: P1 },
      ],
    },
  ],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    ladders: LADDERS,
    roles: ROLES,
    rules,
    assignments: [assignment('a1', u('alice'), 'viewer', P1), assignment('a2', u('alice'), 'editor', P1), assignment('b1', u('bob'), 'viewer', P1), assignment('c1', u('carol'), 'editor', GLOBAL, { expiresAt: later(NOW, -1_000) }), assignment('c2', u('carol'), 'viewer', P1), assignment('e1', u('erin'), 'org.admin', O1), assignment('e2', u('erin'), 'viewer', GLOBAL), assignment('f1', u('frank'), 'editor', P1), assignment('g1', u('gina'), 'viewer', GLOBAL), assignment('h1', u('hank'), 'editor', P1), assignment('h2', u('hank'), 'viewer', f1)],
  },
});

const tooLow = (roleName: string, needed: string): DecisionExpectation => ({ allowed: false, reason: { code: 'role_too_low', ladder: 'project', role: roleName, needed } });

const base = world();

const ladderCases: Case[] = [
  {
    name: 'a ladder role holds the grants of every lower role',
    world: base,
    steps: [{ checkMany: { as: 'frank', permissions: ['file:read', 'file:comment', 'file:edit'], resource: f1 }, expect: { 'file:read': { allowed: true }, 'file:comment': { allowed: true }, 'file:edit': { allowed: true } } }],
  },
  {
    name: 'the effective role per ladder is the highest live one (Decision.roles)',
    world: base,
    steps: [
      { check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: true, roles: { project: 'editor' } } },
      { check: { as: 'erin', permission: 'file:read', resource: f1 }, expect: { allowed: true, roles: { project: 'viewer', org: 'org.admin' } } },
    ],
  },
  {
    name: 'an expired role is not live',
    world: base,
    steps: [{ check: { as: 'carol', permission: 'file:edit', resource: f1 }, expect: { ...tooLow('viewer', 'editor'), roles: { project: 'viewer' } } }],
  },
  {
    name: 'a ladder grant below its needed role denies role_too_low{ladder, role, needed}',
    world: base,
    steps: [
      { check: { as: 'bob', permission: 'file:comment', resource: f1 }, expect: tooLow('viewer', 'commenter') },
      { check: { as: 'bob', permission: 'project:settings', resource: P1 }, expect: tooLow('viewer', 'maintainer') },
    ],
  },
  {
    name: 'needed is the lowest role that grants the permission',
    world: base,
    steps: [{ check: { as: 'bob', permission: 'file:edit', resource: f1 }, expect: tooLow('viewer', 'editor') }],
  },
  {
    name: 'no live role on the ladder denies no_access',
    world: base,
    steps: [{ check: { as: 'dave', permission: 'file:edit', resource: f1 }, expect: { allowed: false, reason: 'no_access' } }],
  },
  {
    name: "ladder grants apply only to the ladder's resourceTypes",
    world: base,
    steps: [
      { check: { as: 'gina', permission: 'file:read', resource: f1 }, expect: { allowed: true } },
      { check: { as: 'gina', permission: 'file:read', resource: O1 }, expect: { allowed: false, reason: 'no_access' } },
      { check: { as: 'erin', permission: 'org:audit', resource: O1 }, expect: { allowed: true } },
    ],
  },
];

const rulesCases: Case[] = [
  {
    name: 'the effective role is taken after caps',
    world: world([{ id: 'cap-p1', kind: 'cap', scope: P1, ladder: 'project', maxRole: 'commenter', source: 'test' }]),
    steps: [{ check: { as: 'alice', permission: 'file:edit', resource: f1 }, expect: { ...tooLow('commenter', 'editor'), roles: { project: 'commenter' } } }],
  },
  {
    name: 'the effective role is taken after restrictions',
    world: world([{ id: 'restrict-f1', kind: 'restrict', scope: f1, allow: [], source: 'test' }]),
    steps: [
      { check: { as: 'hank', permission: 'file:read', resource: f1 }, expect: { allowed: true, roles: { project: 'viewer' } } },
      { check: { as: 'hank', permission: 'file:edit', resource: f1 }, expect: tooLow('viewer', 'editor') },
      { check: { as: 'hank', permission: 'file:edit', resource: f2 }, expect: { allowed: true, roles: { project: 'editor' } } },
    ],
  },
];

export const B31 = fixture('B31', [
  { name: 'ladders', facets: ['engine', 'rbac', 'ladders'], lanes: ['L1b'], note: 'project: viewer < commenter < editor < maintainer on project and file; org: org.member < org.admin.', cases: ladderCases },
  { name: 'rules', facets: ['engine', 'rbac', 'ladders', 'rules'], lanes: ['L1b'], note: '"After restrictions and caps": the rule kinds themselves are B35.', cases: rulesCases },
]);
