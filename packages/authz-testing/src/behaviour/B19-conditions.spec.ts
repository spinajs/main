import type { Policy } from '@spinajs/authz';

import { agentPrincipal, userPrincipal } from '../principals.js';
import { combine, fixture, ref } from './dsl.js';
import type { Case, World } from './types.js';

const O1 = ref('org', 'o1');
const O2 = ref('org', 'o2');
const P1 = ref('project', 'p1');

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const agent = agentPrincipal('ag1', alice, { attributes: { team: 'red' } });

const files = [
  { id: 'f1', status: 'open', owner: 'alice', team: 'red', region: 'eu', tier: 'gold' },
  { id: 'f2', status: 'closed', owner: 'bob', team: 'blue', region: 'us', tier: 'gold' },
  { id: 'f3', status: 'open', owner: 'bob', team: 'red', region: 'eu', tier: 'silver' },
];

// f1 and f2 lie under o1, f3 under o2; branches are scope-resolver nodes with a name attribute.
const world = (policies: readonly Omit<Policy, 'source'>[]): World => ({
  permissions: ['file:read', 'branch:push'],
  principals: { alice, bob, agent },
  adapters: [
    {
      types: ['file', 'org'],
      rows: { file: files, org: [{ id: 'o1' }, { id: 'o2' }] },
      parents: [[ref('file', 'f1'), O1] as const, [ref('file', 'f2'), O1] as const, [ref('file', 'f3'), O2] as const],
      attributes: [[O1, { policies: { level: 'gold', frozen: true, open: false } }] as const, [O2, { policies: { level: 'silver', frozen: false, open: true } }] as const],
    },
  ],
  scopes: [
    {
      nodes: [
        { ref: ref('branch', 'b1'), parent: P1, attributes: { name: 'release/1' } },
        { ref: ref('branch', 'b2'), parent: P1, attributes: { name: 'main' } },
      ],
    },
  ],
  combine: combine('deny-overrides', 'abac'),
  abac: { policies: policies.map((p) => ({ ...p, source: 'test' })) },
});

const ALL = { id: 'all', effect: 'permit', permissions: ['*'] } as const;
const row = (as: string, id: string, extra: { readonly env?: Readonly<Record<string, unknown>> } = {}) => ({ as, permission: 'file:read', resource: ref('file', id), subject: 'row' as const, ...extra });

const cases: Case[] = [
  {
    name: 'a condition on resource.* with a constant becomes a residual',
    world: world([{ id: 'open', effect: 'permit', permissions: ['file:read'], when: { attr: 'resource.status', eq: 'open' } }]),
    steps: [
      { check: { as: 'alice', permission: 'file:read' }, expect: { allowed: true, residual: 'conditional' } },
      { filter: { as: 'alice', permission: 'file:read', type: 'file' }, expect: { selects: ['f1', 'f3'] } },
      { check: row('alice', 'f2'), expect: { allowed: false } },
    ],
  },
  {
    name: 'a principal.* ref is bound to the principal',
    world: world([{ id: 'own', effect: 'permit', permissions: ['file:read'], when: { attr: 'resource.owner', eq: { ref: 'principal.id' } } }]),
    steps: [
      { filter: { as: 'alice', permission: 'file:read', type: 'file' }, expect: { selects: ['f1'] } },
      { filter: { as: 'bob', permission: 'file:read', type: 'file' }, expect: { selects: ['f2', 'f3'] } },
    ],
  },
  {
    name: 'an actor.* ref is bound to the agent acting under inherit',
    world: world([{ id: 'team', effect: 'permit', permissions: ['file:read'], when: { attr: 'resource.team', eq: { ref: 'actor.attributes.team' } } }]),
    steps: [
      { check: row('agent', 'f1'), expect: { allowed: true } },
      { check: row('agent', 'f2'), expect: { allowed: false } },
    ],
  },
  {
    name: 'an env.* ref is bound to the request environment',
    world: world([{ id: 'region', effect: 'permit', permissions: ['file:read'], when: { attr: 'resource.region', eq: { ref: 'env.region' } } }]),
    steps: [
      { check: row('alice', 'f1', { env: { region: 'eu' } }), expect: { allowed: true } },
      { check: row('alice', 'f2', { env: { region: 'eu' } }), expect: { allowed: false } },
      { check: row('alice', 'f2', { env: { region: 'us' } }), expect: { allowed: true } },
      { check: { as: 'alice', permission: 'file:read', env: { region: 'eu' } }, expect: { allowed: true, residual: { selects: ['f1', 'f3'] } } },
      { check: { as: 'alice', permission: 'file:read', env: { region: 'us' } }, expect: { allowed: true, residual: { selects: ['f2'] } } },
    ],
  },
  {
    name: 'a scope.* ref is bound to the nearest ancestor of that type',
    world: world([{ id: 'tier', effect: 'permit', permissions: ['file:read'], when: { attr: 'resource.tier', eq: { ref: 'scope.org.policies.level' } } }]),
    steps: [
      { check: row('alice', 'f1'), expect: { allowed: true } },
      { check: row('alice', 'f3'), expect: { allowed: true } },
      { check: { as: 'alice', permission: 'file:read', resource: ref('file', 'f2'), subject: { ...files[1], tier: 'silver' } }, expect: { allowed: false } },
    ],
  },
  {
    name: 'resource.* becomes a constant when the scope resolver knows the attributes of the resource',
    world: world([ALL, { id: 'release', effect: 'deny', permissions: ['branch:push'], when: { attr: 'resource.name', wildcard: 'release/*' }, reason: 'protected' }]),
    steps: [
      { check: { as: 'alice', permission: 'branch:push', resource: ref('branch', 'b1') }, expect: { allowed: false, reason: 'protected', residual: 'FALSE' } },
      { check: { as: 'alice', permission: 'branch:push', resource: ref('branch', 'b2') }, expect: { allowed: true, residual: 'TRUE' } },
    ],
  },
  {
    name: 'a deny whose condition needs the subject, with none given, denies needs_subject',
    world: world([ALL, { id: 'frozen', effect: 'deny', permissions: ['file:read'], when: { attr: 'scope.org.policies.frozen', eq: true } }]),
    steps: [
      { check: { as: 'alice', permission: 'file:read' }, expect: { allowed: false, reason: 'needs_subject' } },
      { check: row('alice', 'f1'), expect: { allowed: false } },
      { check: row('alice', 'f3'), expect: { allowed: true } },
    ],
  },
  {
    name: 'a permit whose condition needs the subject, with none given, does not permit',
    world: world([{ id: 'open-orgs', effect: 'permit', permissions: ['file:read'], when: { attr: 'scope.org.policies.open', eq: true } }]),
    steps: [
      { check: { as: 'alice', permission: 'file:read' }, expect: { allowed: false } },
      { check: row('alice', 'f3'), expect: { allowed: true } },
      { check: row('alice', 'f1'), expect: { allowed: false } },
    ],
  },
];

export const B19 = fixture('B19', [
  {
    name: 'abac',
    facets: ['engine', 'abac', 'conditions'],
    lanes: ['L3'],
    note: 'The type-level cases rely on design §5.9: a scope.<type>.* ref on a type-level request is a constant only when every row shares that ancestor (here the files lie under o1 and o2), otherwise the condition needs the subject. "Boot warns when such a policy targets a list-scoped type" is a log line the kit cannot observe; L3 asserts it in its own test.',
    cases,
  },
]);
