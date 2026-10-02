import { userPrincipal } from '../principals.js';
import { combine, fixture, permit, ref, staticModel } from './dsl.js';
import type { Step, World } from './types.js';

const alice = userPrincipal('alice');
const f1 = ref('file', 'f1');
const TAGS = ['role:editor', 'subject:user:alice'];

const rootWorld: World = {
  permissions: ['file:read'],
  principals: { alice },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1')],
};

const domainWorld: World = {
  ...rootWorld,
  domains: { fs: { models: [staticModel('m2')], combine: combine('deny-overrides', 'm1', 'm2') } },
};

// m1 (root) votes in both domains; m2 only in fs.
const cachedWorld: World = {
  permissions: ['file:read'],
  principals: { alice },
  config: { cache: { ttlSeconds: 60 } },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: { 'file:read': permit() } })],
  domains: { fs: { models: [staticModel('m2', { votes: { 'file:read': permit() } })], combine: combine('deny-overrides', 'm1', 'm2') } },
};

const readBoth: Step[] = [
  { check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: true } },
  { check: { as: 'alice', permission: 'file:read', resource: f1, domain: 'fs' }, expect: { allowed: true } },
];

export const B27 = fixture('B27', [
  {
    name: 'bus',
    facets: ['engine', 'bus'],
    lanes: ['F4'],
    note: 'The L2 side of the rule is in part cache.',
    world: rootWorld,
    cases: [
      {
        name: "a published AuthzChange reaches the domain's models through invalidate(tags)",
        steps: [{ publish: { tags: TAGS } }, { published: { tags: TAGS, count: 1 } }, { calls: { model: 'm1', method: 'invalidate', atLeast: 1, lastArgs: [TAGS] } }],
      },
    ],
  },
  {
    name: 'domains',
    facets: ['engine', 'bus', 'host'],
    lanes: ['F4'],
    world: domainWorld,
    cases: [
      {
        name: "every domain's AuthzService passes a published change to its models",
        steps: [{ publish: { tags: TAGS } }, { calls: { model: 'm1', method: 'invalidate', atLeast: 1, lastArgs: [TAGS] } }, { calls: { model: 'm2', domain: 'fs', method: 'invalidate', atLeast: 1, lastArgs: [TAGS] } }],
      },
    ],
  },
  {
    name: 'cache',
    facets: ['engine', 'bus', 'cache', 'host'],
    lanes: ['F4'],
    note: 'D-F5-4: of the tags a cached decision carries, a fixture relies only on subject:<principalKey> and model:<name> of a model that voted.',
    world: cachedWorld,
    cases: [
      {
        name: "a published subject:<principal> drops the principal's L2 entries in every domain",
        steps: [...readBoth, ...readBoth, { calls: { model: 'm1', count: 2 } }, { calls: { model: 'm2', domain: 'fs', count: 1 } }, { publish: { tags: ['subject:user:alice'] } }, ...readBoth, { calls: { model: 'm1', count: 4 } }, { calls: { model: 'm2', domain: 'fs', count: 2 } }],
      },
      {
        name: 'a published model:<name> drops the L2 entries that model voted on in every domain',
        steps: [...readBoth, ...readBoth, { calls: { model: 'm1', count: 2 } }, { publish: { tags: ['model:m1'] } }, ...readBoth, { calls: { model: 'm1', count: 4 } }, { calls: { model: 'm2', domain: 'fs', count: 2 } }],
      },
    ],
  },
  { name: 'store', facets: ['store', 'bus'], lanes: ['L2'], note: 'Every store write bumps authz_version(domain) and publishes after commit; L2 proposes the cases with its stores.', cases: [] },
  { name: 'events', facets: ['admin', 'bus'], lanes: ['L9', 'C1', 'C4'], note: 'AuthzAdmin writes publish changes and RoleAssigned/RoleRevoked with actor and scope: with the admin fixtures of B43.', cases: [] },
  { name: 'queue', facets: ['queue', 'bus'], lanes: ['L6'], note: 'QueueChangeBus across two in-memory transports; L6 proposes the case.', cases: [] },
]);
