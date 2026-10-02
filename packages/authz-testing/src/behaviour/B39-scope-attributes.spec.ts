import type { CombiningAlgorithm, ResourceRef } from '@spinajs/authz';

import type { ScriptedVote, VoteFn } from '../fakes/index.js';
import { userPrincipal } from '../principals.js';
import { cmp, combine, fixture, permit, ref, staticModel } from './dsl.js';
import type { Case, World } from './types.js';

const alice = userPrincipal('alice');
const o1 = ref('org', 'o1');
const o2 = ref('org', 'o2');
const o3 = ref('org', 'o3');
const f1 = ref('file', 'f1');
const f2 = ref('file', 'f2');
const f3 = ref('file', 'f3');

// o2 is a sub-org of o1; o3 has no `level`.
const SCOPES: World['scopes'] = [
  {
    nodes: [
      { ref: o1, attributes: { policies: { level: 'gold' } } },
      { ref: o2, parent: o1, attributes: { policies: { level: 'silver' } } },
      { ref: o3, attributes: { policies: {} } },
      { ref: f1, parent: o1 },
      { ref: f2, parent: o2 },
      { ref: f3, parent: o3 },
    ],
  },
];

const TIER_MATCHES_ORG = permit(cmp('tier', 'eq', { ref: 'scope.org.policies.level' }));

const world = (algorithm: CombiningAlgorithm = 'deny-overrides', extra: World['models'] = []): World => ({
  permissions: ['file:read'],
  principals: { alice },
  scopes: SCOPES,
  combine: combine(algorithm, 'm1', ...extra.map((m) => m.name ?? '')),
  models: [staticModel('m1', { votes: { 'file:read': TIER_MATCHES_ORG } }), ...extra],
});

const read = (resource: ResourceRef, subject: object) => ({ check: { as: 'alice', permission: 'file:read', resource, subject } } as const);

/** Permits when the nearest org of the resource has policies.level 'gold', read through ctx.ancestors and ctx.attributes. */
const goldOrgs: VoteFn = async (req, ctx): Promise<ScriptedVote> => {
  const org = (await ctx.ancestors(req.resource))?.find((r) => r.type === 'org');
  const attributes = org ? await ctx.attributes(org) : null;
  return (attributes?.policies as { level?: string } | undefined)?.level === 'gold' ? permit() : {};
};

const core: Case[] = [
  {
    name: 'scope.<type>.* reads the nearest ancestor of that type (scope resolver)',
    world: world(),
    steps: [
      { ...read(f2, { id: 'f2', tier: 'silver' }), expect: { allowed: true } },
      { ...read(f2, { id: 'f2', tier: 'gold' }), expect: { allowed: false } },
      { ...read(f1, { id: 'f1', tier: 'gold' }), expect: { allowed: true } },
    ],
  },
  {
    name: 'a missing attribute makes the vote indeterminate: deny with model_error under deny-overrides',
    world: world(),
    steps: [{ ...read(f3, { id: 'f3', tier: 'gold' }), expect: { allowed: false, reason: { code: 'model_error', model: 'm1' } } }],
  },
  {
    name: 'a missing attribute makes the vote indeterminate: ignored under permit-overrides next to a permit',
    world: world('permit-overrides', [staticModel('m2', { votes: { 'file:read': permit() } })]),
    steps: [{ ...read(f3, { id: 'f3', tier: 'gold' }), expect: { allowed: true } }],
  },
  {
    name: 'scope.<type>.* reads adapter scope attributes for adapter types',
    world: {
      permissions: ['file:read'],
      principals: { alice },
      adapters: [
        {
          types: ['org', 'file'],
          rows: {
            org: [{ id: 'o1' }],
            file: [
              { id: 'f1', tier: 'gold' },
              { id: 'f2', tier: 'silver' },
            ],
          },
          parents: [[f1, o1] as const, [f2, o1] as const],
          attributes: [[o1, { policies: { level: 'gold' } }] as const],
        },
      ],
      combine: combine('deny-overrides', 'm1'),
      models: [staticModel('m1', { votes: { 'file:read': TIER_MATCHES_ORG } })],
    },
    steps: [
      { check: { as: 'alice', permission: 'file:read', resource: f1, subject: 'row' }, expect: { allowed: true } },
      { check: { as: 'alice', permission: 'file:read', resource: f2, subject: 'row' }, expect: { allowed: false } },
    ],
  },
  {
    name: 'a model reads scope attributes through its EvaluationContext',
    world: { ...world(), models: [staticModel('m1', { votes: goldOrgs, capabilities: { sync: 'never' } })] },
    steps: [
      { check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: true } },
      { check: { as: 'alice', permission: 'file:read', resource: f2 }, expect: { allowed: false } },
    ],
  },
];

const abacWorld: World = {
  permissions: ['file:read'],
  principals: { alice },
  scopes: [
    {
      nodes: [
        { ref: o1, attributes: { policies: { open: true } } },
        { ref: o2, attributes: { policies: {} } },
        { ref: f1, parent: o1 },
        { ref: f2, parent: o2 },
      ],
    },
  ],
  combine: combine('deny-overrides', 'abac'),
  abac: { policies: [{ id: 'open-orgs', effect: 'permit', permissions: ['file:read'], when: { attr: 'scope.org.policies.open', eq: true }, source: 'test' }] },
};

export const B39 = fixture('B39', [
  { name: 'core', facets: ['engine'], lanes: ['F3'], note: 'Memoisation per request is an engine-internal property the fixtures do not observe.', cases: core },
  {
    name: 'abac',
    facets: ['engine', 'abac', 'conditions'],
    lanes: ['L3'],
    world: abacWorld,
    cases: [
      { name: 'a condition on scope.org.* reads the nearest org', steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: true } }] },
      { name: 'a condition reading a missing attribute is indeterminate: deny model_error', steps: [{ check: { as: 'alice', permission: 'file:read', resource: f2 }, expect: { allowed: false, reason: { code: 'model_error', model: 'abac' } } }] },
    ],
  },
  { name: 'orm', facets: ['orm'], lanes: ['L4'], note: 'Scope attributes from @AccessResource(type, { attributes }); L4 proposes the cases.', cases: [] },
  { name: 'store', facets: ['admin', 'scopeAttributes', 'bus'], lanes: ['L9'], note: 'Stored attributes win over resolver values, and a change publishes scope:<t>:<id>: with the admin fixtures of B43.', cases: [] },
]);
