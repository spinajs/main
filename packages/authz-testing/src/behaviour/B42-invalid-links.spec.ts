import { userPrincipal } from '../principals.js';
import { assignment, combine, fixture, later, ref, role } from './dsl.js';
import { checks, viaLink, who } from './model-steps.js';
import type { CheckSpec } from './model-steps.js';
import type { Case, World } from './types.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const O1 = ref('org', 'o1');
const P1 = ref('project', 'p1');
const f1 = ref('file', 'f1');

const alice = userPrincipal('alice');
const olga = userPrincipal('olga');

// The org ladder of design §8.5: org.admin implies maintainer with bypass; org.owner is above it.
const world: World = {
  now: NOW,
  permissions: ['file:read', 'file:edit', 'project:settings', 'org:manage'].map((name) => ({ name, types: ['org', 'project', 'file'] })),
  principals: { alice, olga },
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
    ladders: [
      { name: 'project', roles: ['viewer', 'editor', 'maintainer'], resourceTypes: ['project', 'file'] },
      { name: 'org', roles: ['org.member', 'org.admin', 'org.owner'] },
    ],
    roles: [role('viewer', ['file:read'], { ladder: 'project' }), role('editor', ['file:edit'], { ladder: 'project' }), role('maintainer', ['project:settings'], { ladder: 'project' }), role('org.member', [], { ladder: 'org' }), role('org.admin', ['org:manage'], { ladder: 'org', implies: [{ role: 'maintainer', at: 'self-and-descendants', bypass: ['restrict', 'cap'] }] }), role('org.owner', [], { ladder: 'org' })],
    assignments: [assignment('a1', alice, 'org.admin', O1), assignment('o1', olga, 'org.owner', O1)],
    links: [
      { id: 'expired', scope: P1, expiresAt: later(NOW, -1_000), attributes: {}, role: 'editor', token: 'tok-expired' },
      { id: 'revoked', scope: P1, attributes: {}, role: 'editor', token: 'tok-revoked', revoked: true },
    ],
  },
};

const LINK_INVALID = { allowed: false, reason: 'link_invalid' } as const;
const EVERY: readonly CheckSpec[] = [
  { permission: 'file:read', resource: f1, expect: LINK_INVALID },
  { permission: 'file:edit', resource: f1, expect: LINK_INVALID },
  { permission: 'project:settings', resource: P1, expect: LINK_INVALID },
  { permission: 'org:manage', resource: O1, expect: LINK_INVALID },
];
const ALLOWED = { allowed: true } as const;

const cases: Case[] = [
  {
    name: 'control: the org admin and the org owner are allowed without a link',
    steps: [
      checks(
        who('alice'),
        EVERY.map((c) => ({ ...c, expect: ALLOWED })),
      ),
      checks(
        who('olga'),
        EVERY.map((c) => ({ ...c, expect: ALLOWED })),
      ),
    ],
  },
  { name: 'an expired link carried by an org admin denies every check link_invalid', steps: [checks(viaLink('tok-expired', 'alice'), EVERY)] },
  { name: 'a revoked link carried by an org admin denies every check link_invalid', steps: [checks(viaLink('tok-revoked', 'alice'), EVERY)] },
  { name: 'an unknown link carried by an org admin denies every check link_invalid', steps: [checks(viaLink('tok-ghost', 'alice'), EVERY)] },
  { name: 'an invalid link carried by an org owner denies every check link_invalid', steps: [checks(viaLink('tok-expired', 'olga'), EVERY), checks(viaLink('tok-ghost', 'olga'), EVERY)] },
  { name: 'an invalid link without a companion denies every check link_invalid', steps: [checks(viaLink('tok-expired'), EVERY), checks(viaLink('tok-revoked'), EVERY)] },
];

export const B42 = fixture('B42', [
  {
    name: 'rbac',
    facets: ['engine', 'rbac', 'ladders', 'links'],
    lanes: ['L1b'],
    note: 'H21: the link principal replaces the session principal and its ceiling is never bypassed (D19), whoever the companion is. Lane handle rbacLinks.',
    world,
    cases,
  },
  { name: 'canvas', facets: ['canvas'], lanes: ['K1'], note: 'The pinned H21 case of extra-cases.json ("expired link denies an org admin") runs in K1\'s canvas-c6 suite with B40. K1 fills it: a FixtureExtension with the same id and part name, written in test/canvas-c6/ and passed through runBehaviour(…, { fixtures: [...BEHAVIOUR_FIXTURES, ext] }), replaces this empty part (mergeFixtures); K1 declares its canvas handle by augmenting LaneHandles there.', cases: [] },
]);
