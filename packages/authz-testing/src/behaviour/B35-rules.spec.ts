import { GLOBAL } from '@spinajs/authz';
import type { Assignment, RuleDef } from '@spinajs/authz';

import { agentPrincipal, servicePrincipal, userPrincipal } from '../principals.js';
import { assignment, combine, fixture, later, ref, role } from './dsl.js';
import type { Case, DecisionExpectation, World } from './types.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const O1 = ref('org', 'o1');
const O2 = ref('org', 'o2');
const P1 = ref('project', 'p1');
const P3 = ref('project', 'p3');
const f1 = ref('file', 'f1');
const f2 = ref('file', 'f2');
const f3 = ref('file', 'f3');
const b1 = ref('branch', 'b1');
const b2 = ref('branch', 'b2');
const b3 = ref('branch', 'b3');

const PW = ['project', 'org'];
const TYPES = ['org', 'project', 'file', 'branch'];

const ids = ['alice', 'bob', 'carol', 'dan', 'eve', 'ella', 'fay', 'gus', 'hal', 'ivy', 'jon', 'kay', 'lou', 'mia', 'ned', 'olga'] as const;
const principals: World['principals'] = { ...Object.fromEntries(ids.map((id) => [id, userPrincipal(id)])), svc: servicePrincipal('svc'), pam: userPrincipal('pam', { attributes: { contractor: true } }), agentDan: agentPrincipal('ag-dan', userPrincipal('dan')) };
const u = (id: (typeof ids)[number] | 'svc' | 'pam') => principals![id];

// o1 → p1 → f1, f2, b1 'release/1', b2 'release/1/hotfix', b3 'main'; o2 → p3 → f3.
const SCOPES: World['scopes'] = [
  {
    nodes: [
      { ref: O1, attributes: { policies: { max_role: 'commenter', viewers_may_download: false } } },
      { ref: O2, attributes: { policies: { max_role: 'editor', viewers_may_download: true } } },
      { ref: P1, parent: O1 },
      { ref: P3, parent: O2 },
      { ref: f1, parent: P1 },
      { ref: f2, parent: P1 },
      { ref: f3, parent: P3 },
      { ref: b1, parent: P1, attributes: { name: 'release/1' } },
      { ref: b2, parent: P1, attributes: { name: 'release/1/hotfix' } },
      { ref: b3, parent: P1, attributes: { name: 'main' } },
    ],
  },
];

const ROLES = [role('viewer', ['file:read', 'project:export', { permission: 'repo:read', grantedAt: PW }, { permission: 'inspect:view', requiresTag: 'inspect' }], { ladder: 'project' }), role('commenter', ['file:comment'], { ladder: 'project' }), role('editor', ['file:edit'], { ladder: 'project' }), role('maintainer', ['file:admin'], { ladder: 'project' }), role('org.guest', [], { ladder: 'org' }), role('org.member', [], { ladder: 'org' })];

const world = (rules: readonly Omit<RuleDef, 'source'>[], assignments: readonly Assignment[]): World => ({
  now: NOW,
  permissions: ['file:read', 'file:comment', 'file:edit', 'file:admin', 'project:export', 'repo:read', 'inspect:view'].map((name) => ({ name, types: TYPES })),
  principals,
  scopes: SCOPES,
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    ladders: [
      { name: 'project', roles: ['viewer', 'commenter', 'editor', 'maintainer'] },
      { name: 'org', roles: ['org.guest', 'org.member'] },
    ],
    roles: ROLES,
    rules: rules.map((r) => ({ ...r, source: 'test' })),
    assignments,
  },
});

const ALLOWED: DecisionExpectation = { allowed: true };
const NO_ACCESS: DecisionExpectation = { allowed: false, reason: 'no_access' };
const tooLow = (roleName: string, needed: string): DecisionExpectation => ({ allowed: false, reason: { code: 'role_too_low', ladder: 'project', role: roleName, needed } });
const on = (as: string, permission: string, resource: typeof f1, expect: DecisionExpectation) => ({ check: { as, permission, resource }, expect });

const NO_DOWNLOAD = { code: 'policy', rule: 'no_download' };
const editorDan = [assignment('d1', u('dan'), 'editor', P1), assignment('d2', u('dan'), 'editor', P3)];

const ruleCases: Case[] = [
  // restrict
  {
    name: 'restrict drops the assignments made strictly above its node',
    world: world([{ id: 'r1', kind: 'restrict', scope: f1, allow: [] }], [assignment('b1', u('bob'), 'viewer', P1)]),
    steps: [on('bob', 'file:read', f1, NO_ACCESS), on('bob', 'file:read', f2, ALLOWED)],
  },
  {
    name: 'restrict keeps an assignment whose subject it allows',
    world: world([{ id: 'r1', kind: 'restrict', scope: f1, allow: [{ type: 'user', id: 'alice' }] }], [assignment('a1', u('alice'), 'viewer', P1), assignment('b1', u('bob'), 'viewer', P1)]),
    steps: [on('alice', 'file:read', f1, ALLOWED), on('bob', 'file:read', f1, NO_ACCESS)],
  },
  {
    name: 'restrict keeps an assignment made at its node',
    world: world([{ id: 'r1', kind: 'restrict', scope: f1, allow: [] }], [assignment('c1', u('carol'), 'viewer', f1)]),
    steps: [on('carol', 'file:read', f1, ALLOWED)],
  },
  // cap
  {
    name: 'cap clamps the rank of matching assignments',
    world: world([{ id: 'c1', kind: 'cap', scope: P1, ladder: 'project', maxRole: 'commenter' }], editorDan),
    steps: [on('dan', 'file:edit', f1, { ...tooLow('commenter', 'editor'), roles: { project: 'commenter' } }), on('dan', 'file:comment', f1, ALLOWED), on('dan', 'file:edit', f3, ALLOWED)],
  },
  {
    name: 'the minimum of all matching caps applies',
    world: world(
      [
        { id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'commenter' },
        { id: 'c2', kind: 'cap', scope: P1, ladder: 'project', maxRole: 'viewer' },
      ],
      editorDan,
    ),
    steps: [on('dan', 'file:comment', f1, tooLow('viewer', 'commenter')), on('dan', 'file:comment', f3, ALLOWED), on('dan', 'file:edit', f3, tooLow('commenter', 'editor'))],
  },
  {
    name: 'cap with stripTags removes the tags of matching assignments',
    world: world([{ id: 'c1', kind: 'cap', scope: P1, stripTags: true }], [assignment('e1', u('ella'), 'viewer', P1, { tags: ['inspect'] }), assignment('e2', u('ella'), 'viewer', P3, { tags: ['inspect'] })]),
    steps: [on('ella', 'inspect:view', f1, { allowed: false, reason: { code: 'tag_missing', tag: 'inspect' } }), on('ella', 'inspect:view', f3, ALLOWED)],
  },
  {
    name: 'cap with maxRole: null drops matching assignments',
    world: world([{ id: 'c1', kind: 'cap', scope: P1, ladder: 'project', maxRole: null }], editorDan),
    steps: [on('dan', 'file:read', f1, NO_ACCESS), on('dan', 'file:read', f3, ALLOWED)],
  },
  {
    name: 'cap assignment selectors pick the assignments it clamps (scope types)',
    world: world([{ id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'editor', assignments: { scopeTypes: ['file'] } }], [assignment('f1', u('fay'), 'maintainer', f1), assignment('g1', u('gus'), 'maintainer', P1)]),
    steps: [on('fay', 'file:admin', f1, tooLow('editor', 'maintainer')), on('gus', 'file:admin', f1, ALLOWED)],
  },
  {
    name: 'a cap ref (maxRole: { ref }) resolves per request from scope attributes',
    world: world([{ id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'scope.org.policies.max_role' } }], [assignment('h1', u('hal'), 'editor', GLOBAL)]),
    steps: [on('hal', 'file:edit', f1, tooLow('commenter', 'editor')), on('hal', 'file:edit', f3, ALLOWED)],
  },
  // threshold
  {
    name: "threshold denies a matching permission below minRole with the rule's reason",
    world: world([{ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['project:export'], minRole: 'editor', reason: NO_DOWNLOAD }], [assignment('i1', u('ivy'), 'viewer', P1), assignment('j1', u('jon'), 'editor', P1)]),
    steps: [on('ivy', 'project:export', P1, { allowed: false, reason: NO_DOWNLOAD }), on('jon', 'project:export', P1, ALLOWED), on('ivy', 'file:read', f1, ALLOWED)],
  },
  {
    name: 'threshold: the deciding rank of a grantedAt grant is the provenance rank',
    world: world([{ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['repo:read'], minRole: 'editor', reason: { code: 'policy' } }], [assignment('k1', u('kay'), 'viewer', P1), assignment('k2', u('kay'), 'editor', f1), assignment('l1', u('lou'), 'editor', P1)]),
    steps: [on('kay', 'repo:read', f1, { allowed: false, reason: 'policy' }), on('kay', 'file:edit', f1, ALLOWED), on('lou', 'repo:read', f1, ALLOWED)],
  },
  {
    name: 'threshold with ladder and at: the rank on that ladder at the nearest ancestor of that type decides',
    world: world([{ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['file:read'], ladder: 'org', at: 'org', minRole: 'org.member', reason: { code: 'members_only' } }], [assignment('m1', u('mia'), 'viewer', P1), assignment('m2', u('mia'), 'org.member', O1), assignment('n1', u('ned'), 'viewer', P1), assignment('n2', u('ned'), 'org.guest', O1), assignment('o1', u('olga'), 'viewer', P1), assignment('o2', u('olga'), 'org.member', O2)]),
    steps: [on('mia', 'file:read', f1, ALLOWED), on('ned', 'file:read', f1, { allowed: false, reason: 'members_only' }), on('olga', 'file:read', f1, { allowed: false, reason: 'members_only' })],
  },
  {
    name: 'resourceTypes select the requests a rule applies to',
    world: world([{ id: 't1', kind: 'threshold', scope: P1, resourceTypes: ['branch'], permissions: ['file:edit'], minRole: 'maintainer', reason: { code: 'branch_protected' } }], editorDan),
    steps: [on('dan', 'file:edit', b3, { allowed: false, reason: 'branch_protected' }), on('dan', 'file:edit', f1, ALLOWED)],
  },
  {
    name: 'subjects select the principals a rule applies to (principal types)',
    world: world([{ id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', subjects: { principalTypes: ['service'] } }], [...editorDan, assignment('s1', u('svc'), 'editor', P1)]),
    steps: [on('svc', 'file:edit', f1, tooLow('viewer', 'editor')), on('dan', 'file:edit', f1, ALLOWED)],
  },
  {
    name: 'subjects select the principals a rule applies to (refs)',
    world: world([{ id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', subjects: { refs: [{ type: 'user', id: 'dan' }] } }], [...editorDan, assignment('e1', u('eve'), 'editor', P1)]),
    steps: [on('dan', 'file:edit', f1, tooLow('viewer', 'editor')), on('eve', 'file:edit', f1, ALLOWED)],
  },
  {
    name: 'subjects select the principals a rule applies to (actor types: an agent acting for dan under inherit)',
    world: world([{ id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', subjects: { actorTypes: ['agent'] } }], editorDan),
    steps: [on('agentDan', 'file:edit', f1, tooLow('viewer', 'editor')), on('dan', 'file:edit', f1, ALLOWED)],
  },
  {
    name: 'subjects select the principals a rule applies to (rank; no role is below every role)',
    world: world([{ id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'commenter', subjects: { rank: { ladder: 'org', at: 'org', lt: 'org.member' } } }], [...editorDan, assignment('d3', u('dan'), 'org.member', O1), assignment('e1', u('eve'), 'editor', P1), assignment('e2', u('eve'), 'org.guest', O1), assignment('m1', u('mia'), 'editor', P1)]),
    steps: [on('dan', 'file:edit', f1, ALLOWED), on('eve', 'file:edit', f1, tooLow('commenter', 'editor')), on('mia', 'file:edit', f1, tooLow('commenter', 'editor'))],
  },
  {
    name: 'an expired rule contributes nothing',
    world: world([{ id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', expiresAt: later(NOW, -1_000) }], editorDan),
    steps: [on('dan', 'file:edit', f1, ALLOWED)],
  },
  {
    name: 'a rule applies at its scope and below only',
    world: world([{ id: 'c1', kind: 'cap', scope: P3, ladder: 'project', maxRole: 'viewer' }], editorDan),
    steps: [on('dan', 'file:edit', f1, ALLOWED), on('dan', 'file:edit', f3, tooLow('viewer', 'editor'))],
  },
];

const BRANCH_REASON = (pattern: string) => ({ code: 'branch_protected', pattern, needed: 'maintainer', priority: 700, sortKey: pattern });

const conditionCases: Case[] = [
  {
    name: 'when selects the rules that apply (a scope attribute)',
    world: world([{ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['project:export'], minRole: 'editor', when: { attr: 'scope.org.policies.viewers_may_download', eq: false }, reason: NO_DOWNLOAD }], [assignment('i1', u('ivy'), 'viewer', P1), assignment('i2', u('ivy'), 'viewer', P3)]),
    steps: [on('ivy', 'project:export', P1, { allowed: false, reason: NO_DOWNLOAD }), on('ivy', 'project:export', P3, ALLOWED)],
  },
  {
    name: 'subjects.when selects the principals a rule applies to (a principal attribute)',
    world: world([{ id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', subjects: { when: { attr: 'principal.attributes.contractor', eq: true } } }], [...editorDan, assignment('p1', u('pam'), 'editor', P1)]),
    steps: [on('pam', 'file:edit', f1, tooLow('viewer', 'editor')), on('dan', 'file:edit', f1, ALLOWED)],
  },
  {
    name: "a wildcard resource pattern selects by the resource's attribute ('*' crosses '/')",
    world: world([{ id: 't1', kind: 'threshold', scope: P1, resourceTypes: ['branch'], permissions: ['file:edit'], resource: { attr: 'resource.name', wildcard: 'release/*' }, minRole: 'maintainer', reason: BRANCH_REASON('release/*') }], editorDan),
    steps: [on('dan', 'file:edit', b1, { allowed: false, reason: { code: 'branch_protected', pattern: 'release/*' } }), on('dan', 'file:edit', b2, { allowed: false, reason: 'branch_protected' }), on('dan', 'file:edit', b3, ALLOWED)],
  },
  {
    name: "a glob resource pattern selects by the resource's attribute ('*' stops at '/')",
    world: world([{ id: 't1', kind: 'threshold', scope: P1, resourceTypes: ['branch'], permissions: ['file:edit'], resource: { attr: 'resource.name', glob: 'release/*' }, minRole: 'maintainer', reason: BRANCH_REASON('release/*') }], editorDan),
    steps: [on('dan', 'file:edit', b1, { allowed: false, reason: 'branch_protected' }), on('dan', 'file:edit', b2, ALLOWED), on('dan', 'file:edit', b3, ALLOWED)],
  },
];

export const B35 = fixture('B35', [
  {
    name: 'rules',
    facets: ['engine', 'rbac', 'ladders', 'rules'],
    lanes: ['L1b'],
    note: 'Rules from config (ConfigRuleStore). The rank selector reads the org ladder at the nearest org; a principal without an org role there is below every role. Org attributes come from the kit scope resolver: o1 max_role commenter, o2 editor.',
    cases: ruleCases,
  },
  {
    name: 'conditions',
    facets: ['engine', 'rbac', 'ladders', 'rules', 'conditions'],
    lanes: ['L1b'],
    note: 'Rules with when and resource conditions need the core ConditionCompiler (L3 task 2, dotted for L1b). Branch names are resource attributes from the scope resolver (design §5.9).',
    cases: conditionCases,
  },
]);
