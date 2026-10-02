import { GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AuthzCommand, Policy, ResourceRef, RuleDef } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { assignment, combine, fixture, ref, role } from './dsl.js';
import { exec, httpRefuses, mark, savedId, since, tokenOnlyInResult } from './model-steps.js';
import type { Via } from './model-steps.js';
import type { Case, DecisionExpectation, World } from './types.js';

const O1 = ref('org', 'o1');
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const f1 = ref('file', 'f1');

const TYPES = ['org', 'project', 'file'];
const MANAGE = ['authz:assignments.manage', 'authz:links.manage', 'authz:rules.manage'];

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const dora = userPrincipal('dora');
const root = userPrincipal('root');

const world = (extra: Partial<World> = {}): World => ({
  permissions: ['file:read', 'grants:manage', 'authz:links.read', ...MANAGE].map((name) => ({ name, types: TYPES })),
  principals: { alice, bob, carol, dora, root },
  scopes: [
    {
      nodes: [
        { ref: P1, parent: O1 },
        { ref: f1, parent: P1 },
        { ref: P2, parent: O1 },
      ],
    },
  ],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('viewer', ['file:read']), role('manager', [...MANAGE, 'file:read']), role('granter', ['grants:manage', 'file:read']), role('org.role', ['file:read'], { scopeTypes: ['org'] }), role('superuser', [...MANAGE, 'authz:links.read', 'grants:manage', 'file:read'])],
    assignments: [assignment('b1', bob, 'manager', P1), assignment('d1', dora, 'granter', P1), assignment('r1', root, 'superuser', GLOBAL)],
  },
  ...extra,
});

const grant = (roleName: string, scope: ResourceRef = P1, id = 'alice'): AuthzCommand => ({ kind: 'assignment.grant', subject: { type: 'user', id }, role: roleName, scope });
const READS: DecisionExpectation = { allowed: true };
const NO_READ: DecisionExpectation = { allowed: false };
const aliceReads = (expect: DecisionExpectation) => ({ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect });

const commandCases = (via: Via): Case[] => [
  { name: 'a command naming an unknown role is refused (unknown_role)', world: world(), steps: [exec('root', [grant('ghost')], { failsAt: 0, code: 'unknown_role' }, { via })] },
  { name: 'a command outside the scope types of its role is refused (wrong_scope_type)', world: world(), steps: [exec('root', [grant('org.role', P1)], { failsAt: 0, code: 'wrong_scope_type' }, { via }), exec('root', [grant('org.role', O1)], 'ok', { via })] },
  {
    name: "the actor needs the command's permission at the command's scope",
    world: world(),
    steps: [exec('bob', [grant('viewer', P1)], 'ok', { via }), exec('bob', [grant('viewer', P2, 'carol')], { failsAt: 0, code: 'forbidden' }, { via }), exec('carol', [grant('viewer', P1, 'dora')], { failsAt: 0, code: 'forbidden' }, { via }), aliceReads(READS)],
  },
  {
    name: 'authz.admin.permissions maps a command kind and scope type to another permission',
    world: world({ config: { admin: { permissions: { 'assignment.*': { project: 'grants:manage' } } } } }),
    steps: [exec('dora', [grant('viewer', P1)], 'ok', { via }), exec('bob', [grant('viewer', P1, 'carol')], { failsAt: 0, code: 'forbidden' }, { via }), aliceReads(READS)],
  },
  { name: 'the AdminGuard runs for every command', world: world(), steps: [exec('bob', [grant('granter', P1)], { failsAt: 0, code: 'escalation' }, { via })] },
  {
    name: 'a batch is all or nothing: a validation failure rolls back the commands before it',
    world: world(),
    // B43.http declares no bus facet, so only the in-process part counts published changes.
    steps: [mark('batch'), exec('root', [grant('viewer'), grant('ghost')], { failsAt: 1, code: 'unknown_role' }, { via }), aliceReads(NO_READ), ...(via === 'admin' ? [since('batch', { published: 0 })] : [])],
  },
  {
    name: 'a batch is all or nothing: a guard failure rolls back the commands before it',
    world: world(),
    steps: [exec('bob', [grant('viewer'), grant('granter', P1, 'carol')], { failsAt: 1, code: 'escalation' }, { via }), aliceReads(NO_READ)],
  },
  {
    name: 'a retried batch with the same idempotency key has no second effect',
    world: world(),
    steps: [exec('root', [grant('viewer')], 'ok', { via, idempotencyKey: 'k1', save: 'first' }), exec('root', (s) => [{ kind: 'assignment.revoke', id: savedId(s, 'first') }], 'ok', { via }), exec('root', [grant('viewer')], 'ok', { via, idempotencyKey: 'k1', sameAs: 'first' }), aliceReads(NO_READ)],
  },
  {
    name: 'a link token appears only in the command result',
    world: world(),
    steps: [exec('root', [{ kind: 'link.create', scope: P1, role: 'viewer' }], 'ok', { via, save: 'link' }), tokenOnlyInResult('link', 0, via, 'root')],
  },
];

const afterCommitCases: Case[] = [
  {
    name: 'a committed batch publishes one AuthzChange and writes one audit entry per command',
    world: world(),
    steps: [mark('batch'), exec(SYSTEM, [grant('viewer'), grant('viewer', P1, 'carol')], 'ok'), since('batch', { published: 1, adminAudit: 2 }), aliceReads(READS)],
  },
  {
    name: 'a retried batch publishes and audits nothing again',
    world: world(),
    steps: [mark('batch'), exec(SYSTEM, [grant('viewer')], 'ok', { idempotencyKey: 'k1', save: 'first' }), exec(SYSTEM, [grant('viewer')], 'ok', { idempotencyKey: 'k1', sameAs: 'first' }), since('batch', { published: 1, adminAudit: 1 })],
  },
];

const ruleWorld = (): World => ({
  ...world(),
  rbac: { ...world().rbac, ladders: [{ name: 'project', roles: ['viewer', 'editor'] }], roles: [role('viewer', ['file:read'], { ladder: 'project' }), role('editor', ['file:edit'], { ladder: 'project' })], assignments: [] },
  permissions: ['file:read', 'file:edit', ...MANAGE].map((name) => ({ name, types: TYPES })),
});

const rule = (r: Partial<Omit<RuleDef, 'source'>>): AuthzCommand => ({ kind: 'rule.put', rule: { id: 'r1', kind: 'threshold', scope: P1, permissions: ['file:edit'], minRole: 'editor', ...r } });

const ruleCases: Case[] = [
  { name: 'a rule naming an unknown ladder is refused (unknown_ladder)', world: ruleWorld(), steps: [exec(SYSTEM, [rule({ ladder: 'ghost', at: 'project' })], { failsAt: 0, code: 'unknown_ladder' })] },
  { name: 'a rule naming an unknown role is refused (unknown_role)', world: ruleWorld(), steps: [exec(SYSTEM, [rule({ ladder: 'project', at: 'project', minRole: 'ghost' })], { failsAt: 0, code: 'unknown_role' })] },
  { name: 'a DB rule outside SQL form is refused (rule_not_compilable)', world: ruleWorld(), steps: [exec(SYSTEM, [rule({ resource: { attr: 'resource.name', glob: 'a*b*' } })], { failsAt: 0, code: 'rule_not_compilable' })] },
  { name: 'a rule in SQL form is accepted', world: ruleWorld(), steps: [exec(SYSTEM, [rule({ resource: { attr: 'resource.name', wildcard: 'release/*' } })], 'ok')] },
];

const policyWorld = (): World => ({
  permissions: ['file:read', 'authz:policies.manage'].map((name) => ({ name, types: TYPES })),
  principals: { alice },
  scopes: [{ nodes: [{ ref: P1, parent: O1 }] }],
  combine: combine('deny-overrides', 'abac'),
  abac: { policies: [] },
});

const policy = (p: Partial<Omit<Policy, 'source'>>): AuthzCommand => ({ kind: 'policy.put', policy: { id: 'p1', effect: 'deny', permissions: ['file:read'], scope: O1, ...p } });

const policyCases: Case[] = [
  { name: 'a policy naming an unknown permission is refused (unknown_permission)', world: policyWorld(), steps: [exec(SYSTEM, [policy({ permissions: ['ghost:read'] })], { failsAt: 0, code: 'unknown_permission' })] },
  { name: 'a policy whose condition does not parse is refused', world: policyWorld(), steps: [exec(SYSTEM, [policy({ when: { attr: 'resource.status', bogus: 'x' } })], { failsAt: 0 })] },
  {
    name: 'a valid policy is accepted and applies',
    world: policyWorld(),
    steps: [exec(SYSTEM, [policy({ effect: 'permit', when: { attr: 'principal.id', eq: 'alice' } })], 'ok'), { check: { as: 'alice', permission: 'file:read', resource: P1 }, expect: { allowed: true } }],
  },
];

const ORG_SCHEMA = {
  scopeType: 'org',
  schema: { type: 'object', properties: { policies: { type: 'object', properties: { public_links: { type: 'boolean' } }, additionalProperties: false } }, additionalProperties: false },
  defaults: { policies: { public_links: true } },
};

const attributeWorld = (): World => ({
  permissions: [{ name: 'authz:scope.manage', types: TYPES }],
  principals: { alice },
  scopes: [{ nodes: [{ ref: O1 }] }],
  combine: combine('deny-overrides', 'rbac'),
  rbac: { roles: [] },
  scopeAttributes: { schemas: [ORG_SCHEMA] },
});

const attributeCases: Case[] = [
  { name: "an attribute patch that breaks the scope type's schema is refused (invalid_attributes)", world: attributeWorld(), steps: [exec(SYSTEM, [{ kind: 'scope.setAttributes', scope: O1, patch: { policies: { public_links: 'sometimes' } } }], { failsAt: 0, code: 'invalid_attributes' })] },
  { name: 'an attribute patch that fits the schema is accepted', world: attributeWorld(), steps: [exec(SYSTEM, [{ kind: 'scope.setAttributes', scope: O1, patch: { policies: { public_links: false } } }], 'ok')] },
];

const eventCases: Case[] = [
  { name: 'a committed batch emits its events after commit', world: world(), steps: [mark('batch'), exec(SYSTEM, [grant('viewer')], 'ok'), since('batch', { events: { atLeast: 1 } })] },
  { name: 'a failed batch emits no event', world: world(), steps: [mark('batch'), exec(SYSTEM, [grant('viewer'), grant('ghost')], { failsAt: 1 }), since('batch', { events: 0 })] },
];

export const B43 = fixture('B43', [
  {
    name: 'admin',
    facets: ['engine', 'rbac', 'admin', 'audit', 'bus'],
    lanes: ['L9'],
    note: 'Assignment and link commands on the memory stores or on SQLite (L9 runs both). root holds every authz:*.manage permission at GLOBAL (the command cases use root, not SYSTEM, so the HTTP part can send the same actor); bob holds manager (authz:*.manage, file:read) and dora granter (grants:manage, file:read) at p1. "Data changes only through AuthzAdmin" (no public store writes) and the authz_version bump are not observable from a harness; the bump shows as the published change.',
    cases: [...commandCases('admin'), ...afterCommitCases],
  },
  { name: 'rules', facets: ['admin', 'rbac', 'ladders', 'rules'], lanes: ['L9', 'L2'], note: 'rule.put validation: ladders, roles and the SQL form of DB rules (D24, L2 toSqlForm). A threshold names `ladder` only with `at` (design §5.8), so each refused rule has exactly one fault.', cases: ruleCases },
  { name: 'policies', facets: ['engine', 'admin', 'abac', 'conditions'], lanes: ['L9', 'L3'], note: 'policy.put validation. No AuthzAdminError code is specified for a condition that does not parse, so that case asserts the failure only.', cases: policyCases },
  { name: 'attributes', facets: ['admin', 'scopeAttributes'], lanes: ['L9'], note: 'scope.setAttributes against the ScopeAttributeSchema of the scope type.', cases: attributeCases },
  { name: 'events', facets: ['admin', 'rbac'], lanes: ['L9'], note: 'Lane handle adminEvents (a recording AuthzEventSink). Event names and payloads are B27.events.', cases: eventCases },
  {
    name: 'http',
    facets: ['http', 'engine', 'rbac'],
    lanes: ['C4'],
    note: 'The command cases through POST /authz/commands and GET /authz/links (lane handle adminHttp): the HTTP path must answer as the in-process path does. No bus facet: the published-change count of a failed batch is asserted in B43.admin only.',
    cases: [...commandCases('http'), { name: 'a request without credentials is refused with 401', world: world(), steps: [httpRefuses(undefined, [grant('viewer')], 401), aliceReads(NO_READ)] }],
  },
]);
