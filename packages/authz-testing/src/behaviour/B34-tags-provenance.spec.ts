import { userPrincipal } from '../principals.js';
import { assignment, combine, fixture, later, ref, role } from './dsl.js';
import type { Case, DecisionExpectation, World } from './types.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const O1 = ref('org', 'o1');
const P1 = ref('project', 'p1');
const f1 = ref('file', 'f1');

const PW = ['project', 'org'];
const TYPES = ['org', 'project', 'file'];

const ids = ['a', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'hank', 'ivan', 'judy', 'kim', 'leo'] as const;
const principals = Object.fromEntries(ids.map((id) => [id, userPrincipal(id)]));
const u = (id: (typeof ids)[number]) => principals[id];

// release:cut can fail at every step: it needs editor, the beta tag and project-derived access.
const ROLES = [
  role('viewer', ['file:read', { permission: 'inspect:view', requiresTag: 'inspect' }, { permission: 'repo:read', grantedAt: PW }], { ladder: 'project' }),
  role(
    'editor',
    [
      { permission: 'mr:approve', grantedAt: PW },
      { permission: 'release:cut', requiresTag: 'beta', grantedAt: PW },
    ],
    { ladder: 'project' },
  ),
];

const world: World = {
  now: NOW,
  permissions: ['file:read', 'inspect:view', 'repo:read', 'mr:approve', 'release:cut'].map((name) => ({ name, types: TYPES })),
  principals,
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
    ladders: [{ name: 'project', roles: ['viewer', 'editor'] }],
    roles: ROLES,
    assignments: [assignment('a1', u('a'), 'viewer', P1, { tags: ['inspect'] }), assignment('b1', u('bob'), 'viewer', P1), assignment('c1', u('carol'), 'viewer', P1), assignment('c2', u('carol'), 'viewer', O1, { tags: ['inspect'] }), assignment('d1', u('dave'), 'viewer', P1), assignment('d2', u('dave'), 'viewer', O1, { tags: ['inspect'], expiresAt: later(NOW, -1_000) }), assignment('e1', u('erin'), 'editor', f1), assignment('f1', u('frank'), 'viewer', P1), assignment('f2', u('frank'), 'editor', f1), assignment('g1', u('gina'), 'editor', P1), assignment('h1', u('hank'), 'viewer', P1), assignment('i1', u('ivan'), 'editor', f1), assignment('j1', u('judy'), 'editor', f1, { tags: ['beta'] }), assignment('k1', u('kim'), 'viewer', P1), assignment('k2', u('kim'), 'editor', f1, { tags: ['beta'] }), assignment('l1', u('leo'), 'editor', P1, { tags: ['beta'] })],
  },
};

const on = (as: string, permission: string, expect: DecisionExpectation) => ({ check: { as, permission, resource: f1 }, expect });
const tooLow = (roleName: string): DecisionExpectation => ({ allowed: false, reason: { code: 'role_too_low', ladder: 'project', role: roleName, needed: 'editor' } });
const tagMissing = (tag: string): DecisionExpectation => ({ allowed: false, reason: { code: 'tag_missing', tag } });
const PROVENANCE: DecisionExpectation = { allowed: false, reason: 'provenance' };
const ALLOWED: DecisionExpectation = { allowed: true };

const cases: Case[] = [
  { name: 'requiresTag: a live assignment carrying the tag passes', steps: [on('a', 'inspect:view', ALLOWED)] },
  { name: 'requiresTag: no live tag denies tag_missing{tag}', steps: [on('bob', 'inspect:view', tagMissing('inspect'))] },
  { name: 'the tags are the union over all live assignments on the path', steps: [on('carol', 'inspect:view', ALLOWED)] },
  { name: 'the tags of an expired assignment do not count', steps: [on('dave', 'inspect:view', tagMissing('inspect'))] },
  { name: 'grantedAt: no live assignment made at those scope types denies provenance', steps: [on('erin', 'repo:read', PROVENANCE), on('erin', 'mr:approve', PROVENANCE)] },
  { name: 'grantedAt: the rank from the assignments made there decides, else role_too_low on that rank', steps: [on('frank', 'mr:approve', tooLow('viewer')), on('gina', 'mr:approve', ALLOWED)] },
  { name: 'order: the role is checked first', steps: [on('hank', 'release:cut', tooLow('viewer'))] },
  { name: 'order: the tag before provenance', steps: [on('ivan', 'release:cut', tagMissing('beta'))] },
  { name: 'order: provenance before the provenance rank', steps: [on('judy', 'release:cut', PROVENANCE)] },
  { name: 'order: the provenance rank last', steps: [on('kim', 'release:cut', tooLow('viewer')), on('leo', 'release:cut', ALLOWED)] },
];

export const B34 = fixture('B34', [
  {
    name: 'ladders',
    facets: ['engine', 'rbac', 'ladders'],
    lanes: ['L1b'],
    note: 'Design §6.1.2 steps 5-7 (role 410, tag 420, provenance 430, provenance rank 440). The payload of provenance{needed} is not specified beyond its name, so only the code is asserted.',
    world,
    cases,
  },
]);
