import { GLOBAL, SYSTEM } from '@spinajs/authz';
import type { RuleDef } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { assignment, combine, fixture, ref, role } from './dsl.js';
import { checks, exec, setResolverAttributes, viaLink } from './model-steps.js';
import type { Case, DecisionExpectation, Step, World } from './types.js';

const O1 = ref('org', 'o1');
const O2 = ref('org', 'o2');
const O3 = ref('org', 'o3');
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const P3 = ref('project', 'p3');
const G1 = ref('group', 'g1');
const f1 = ref('file', 'f1');
const f2 = ref('file', 'f2');
const f3 = ref('file', 'f3');

const ext = userPrincipal('ext');
const ext2 = userPrincipal('ext2');
const mem = userPrincipal('mem');

const policies = (external_sharing: boolean, public_links: boolean) => ({ policies: { external_sharing, public_links } });

// Rules of design §8.5, verbatim but for their scope (config rules apply at GLOBAL).
const EXTERNAL_SHARING_OFF: Omit<RuleDef, 'source'> = {
  id: 'external-sharing-off',
  kind: 'cap',
  scope: GLOBAL,
  ladder: 'project',
  maxRole: null,
  subjects: { principalTypes: ['user'], rank: { ladder: 'org', at: 'org', lt: 'org.guest' } },
  assignments: { subjectTypes: ['user', 'group'] },
  when: { attr: 'scope.org.policies.external_sharing', eq: false },
};
const LINK_MEMBERS_ONLY: Omit<RuleDef, 'source'> = {
  id: 'link-members-only',
  kind: 'threshold',
  scope: GLOBAL,
  permissions: ['*'],
  subjects: { principalTypes: ['link'] },
  when: {
    any: [
      { attr: 'principal.attributes.org_only', eq: true },
      { attr: 'scope.org.policies.public_links', eq: false },
    ],
  },
  ladder: 'org',
  at: 'org',
  minRole: 'org.guest',
  reason: { code: 'link_invalid', priority: 300 },
};

const ORG_SCHEMA = {
  scopeType: 'org',
  schema: { type: 'object', properties: { policies: { type: 'object', properties: { external_sharing: { type: 'boolean' }, public_links: { type: 'boolean' } } } } },
  defaults: policies(true, true),
};

// o1: external sharing off; o2: on; o3: on, public links off.
const world = (attributes: { readonly o1?: Readonly<Record<string, unknown>>; readonly withStore?: boolean } = {}): World => ({
  permissions: ['file:read', 'file:edit', 'authz:scope.manage'].map((name) => ({ name, types: ['org', 'project', 'file'] })),
  principals: { ext, ext2, mem },
  scopes: [
    {
      nodes: [{ ref: O1, attributes: attributes.o1 ?? policies(false, true) }, { ref: O2, attributes: policies(true, true) }, { ref: O3, attributes: policies(true, false) }, { ref: P1, parent: O1 }, { ref: P2, parent: O2 }, { ref: P3, parent: O3 }, { ref: f1, parent: P1 }, { ref: f2, parent: P2 }, { ref: f3, parent: P3 }, { ref: G1 }],
    },
  ],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    ladders: [
      { name: 'project', roles: ['viewer', 'editor'], resourceTypes: ['project', 'file'] },
      { name: 'org', roles: ['org.guest', 'org.member'] },
    ],
    roles: [role('viewer', ['file:read'], { ladder: 'project' }), role('editor', ['file:edit'], { ladder: 'project' }), role('org.guest', [], { ladder: 'org' }), role('org.member', [], { ladder: 'org', subjectSet: true }), role('group.member', [], { subjectSet: true })],
    rules: [EXTERNAL_SHARING_OFF, LINK_MEMBERS_ONLY].map((r) => ({ ...r, source: 'test' })),
    assignments: [assignment('e1', ext, 'editor', P1), assignment('e2', ext, 'editor', P2), assignment('x1', ext2, 'group.member', G1), { id: 'g1', subject: { set: { role: 'group.member', scope: G1 } }, role: 'editor', scope: P1, source: 'test' }, assignment('m1', mem, 'org.member', O1), assignment('m2', mem, 'editor', P1)],
    links: [
      { id: 'l1', scope: P1, attributes: { org_only: false }, role: 'viewer', token: 'tok-l1' },
      { id: 'l3', scope: P3, attributes: { org_only: false }, role: 'viewer', token: 'tok-l3' },
    ],
  },
  ...(attributes.withStore ? { scopeAttributes: { schemas: [ORG_SCHEMA], values: [{ scope: O1, attributes: policies(false, true) }] } } : {}),
});

const NO_ACCESS: DecisionExpectation = { allowed: false, reason: 'no_access' };
const ALLOWED: DecisionExpectation = { allowed: true };
const on = (as: string, permission: string, resource: typeof f1, expect: DecisionExpectation): Step => ({ check: { as, permission, resource }, expect });

const ruleCases: Case[] = [
  { name: 'with external_sharing false an external user loses its own assignments under that org (no_access)', world: world(), steps: [on('ext', 'file:edit', f1, NO_ACCESS), on('ext', 'file:read', f1, NO_ACCESS)] },
  { name: 'with external_sharing false an external user loses its group assignments too', world: world(), steps: [on('ext2', 'file:edit', f1, NO_ACCESS)] },
  { name: 'an org member keeps its assignments', world: world(), steps: [on('mem', 'file:edit', f1, ALLOWED)] },
  { name: 'in an org with external_sharing true the external user keeps access', world: world(), steps: [on('ext', 'file:edit', f2, ALLOWED)] },
  {
    name: 'setting it back restores access at check time',
    world: world(),
    steps: [on('ext', 'file:edit', f1, NO_ACCESS), setResolverAttributes(O1, policies(true, true)), { invalidate: ['scope:org:o1'] }, on('ext', 'file:edit', f1, ALLOWED), on('ext2', 'file:edit', f1, ALLOWED)],
  },
];

const linkCases: Case[] = [
  { name: 'a link under an org with external_sharing false still grants: public_links governs links', world: world(), steps: [checks(viaLink('tok-l1'), [{ permission: 'file:read', resource: f1, expect: ALLOWED }])] },
  { name: 'public_links false denies a link link_invalid', world: world(), steps: [checks(viaLink('tok-l3'), [{ permission: 'file:read', resource: f3, expect: { allowed: false, reason: 'link_invalid' } }])] },
];

const setO1 = (external_sharing: boolean) => exec(SYSTEM, [{ kind: 'scope.setAttributes', scope: O1, patch: { policies: { external_sharing } } }], 'ok');

const storeCases: Case[] = [
  {
    name: 'scope.setAttributes switches access at the next check, both ways',
    world: world({ o1: policies(true, true), withStore: true }),
    steps: [on('ext', 'file:edit', f1, NO_ACCESS), setO1(true), on('ext', 'file:edit', f1, ALLOWED), setO1(false), on('ext', 'file:edit', f1, NO_ACCESS)],
  },
];

const cacheCases: Case[] = [
  {
    name: 'the change publishes scope:org:<id>, which drops the cached decisions',
    world: { ...world({ o1: policies(true, true), withStore: true }), config: { cache: { ttlSeconds: 60 } } },
    steps: [on('ext', 'file:edit', f1, NO_ACCESS), on('ext', 'file:edit', f1, NO_ACCESS), setO1(true), { published: { tags: ['scope:org:o1'] } }, on('ext', 'file:edit', f1, ALLOWED), setO1(false), on('ext', 'file:edit', f1, NO_ACCESS)],
  },
];

export const B46 = fixture('B46', [
  {
    name: 'rules',
    facets: ['engine', 'rbac', 'ladders', 'rules', 'conditions'],
    lanes: ['L1b'],
    note: 'The external-sharing-off cap of design §8.5; org attributes come from the kit scope resolver, and setResolverAttributes changes them in place.',
    cases: ruleCases,
  },
  { name: 'links', facets: ['engine', 'rbac', 'ladders', 'rules', 'conditions', 'links'], lanes: ['L1b'], note: 'The link-members-only threshold of design §8.5; lane handle rbacLinks.', cases: linkCases },
  {
    name: 'store',
    facets: ['engine', 'rbac', 'ladders', 'rules', 'conditions', 'admin', 'scopeAttributes'],
    lanes: ['L9'],
    note: 'The org attributes in the ScopeAttributeStore (stored values win over the resolver, which says external_sharing true), changed through AuthzAdmin.',
    cases: storeCases,
  },
  { name: 'cache', facets: ['engine', 'rbac', 'ladders', 'rules', 'conditions', 'admin', 'scopeAttributes', 'cache', 'bus'], lanes: ['L9'], note: 'B46 cache part (L9 task 5).', cases: cacheCases },
  { name: 'canvas', facets: ['canvas'], lanes: ['K1'], note: 'The pinned H27 case of extra-cases.json ("external sharing off cuts an existing external grant") runs in K1\'s canvas-c6 suite with B40. K1 fills it: a FixtureExtension with the same id and part name, written in test/canvas-c6/ and passed through runBehaviour(…, { fixtures: [...BEHAVIOUR_FIXTURES, ext] }), replaces this empty part (mergeFixtures); K1 declares its canvas handle by augmenting LaneHandles there.', cases: [] },
]);
