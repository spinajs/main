import { userPrincipal } from '../principals.js';
import { assignment, combine, fixture, later, permit, ref, role, staticModel } from './dsl.js';
import type { Case, Step, World } from './types.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const HOUR = 3_600_000;
const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const f1 = ref('file', 'f1');

const world = (models: World['models'], extra: Partial<World> = {}): World => ({
  now: NOW,
  permissions: ['file:read', 'file:write'],
  principals: { alice, bob },
  combine: combine('deny-overrides', ...(models ?? []).map((m) => m.name ?? '')),
  models,
  ...extra,
});

const READ: Step = { check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: true } };
const calls = (count: number): Step => ({ calls: { model: 'm1', count } });

const core: Case[] = [
  {
    name: 'decision.validUntil is the earliest expiry among the permitting votes',
    world: world([staticModel('m1', { votes: { 'file:read': permit(undefined, { validUntil: later(NOW, HOUR) }) } }), staticModel('m2', { votes: { 'file:read': permit(undefined, { validUntil: later(NOW, 2 * HOUR) }) } })]),
    steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: true, validUntil: later(NOW, HOUR) } }],
  },
  {
    name: 'no expiring contributor: no validUntil',
    world: world([staticModel('m1', { votes: { 'file:read': permit() } })]),
    steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: true, validUntil: null } }],
  },
];

const cache: Case[] = [
  {
    name: 'a cached decision is served until validUntil and never after it (TTL ≤ validUntil)',
    world: world([staticModel('m1', { votes: { 'file:read': permit(undefined, { validUntil: later(NOW, 10_000) }) } })], { config: { cache: { ttlSeconds: 60 } } }),
    steps: [READ, calls(1), { advance: 5_000 }, READ, calls(1), { advance: 6_000 }, READ, calls(2)],
  },
  {
    name: 'authz.cache.ttlSeconds bounds a decision without validUntil',
    world: world([staticModel('m1', { votes: { 'file:read': permit() } })], { config: { cache: { ttlSeconds: 5 } } }),
    steps: [READ, READ, calls(1), { advance: 6_000 }, READ, calls(2)],
  },
  {
    name: 'a decision with a vote that is not cacheable is never cached',
    world: world([staticModel('m1', { votes: { 'file:read': permit(undefined, { cacheable: false }) } })], { config: { cache: { ttlSeconds: 60 } } }),
    steps: [READ, READ, calls(2)],
  },
  {
    name: "a model's version change drops its cached decisions",
    world: world([staticModel('m1', { votes: { 'file:read': permit() } })], { config: { cache: { ttlSeconds: 60 } } }),
    steps: [READ, { do: (ctx) => void ctx.staticModel('m1').respond({}).bump(), note: 'm1 stops permitting and bumps its version' }, { check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: false } }, calls(2)],
  },
  // D-F5-4: the only tags a fixture may rely on are subject:<principalKey> and model:<name> of a voter.
  {
    name: "invalidate(['subject:<principal>']) drops the principal's cached decision",
    world: world([staticModel('m1', { votes: { 'file:read': permit() } })], { config: { cache: { ttlSeconds: 60 } } }),
    steps: [READ, READ, calls(1), { invalidate: ['subject:user:alice'] }, READ, calls(2)],
  },
  {
    name: "invalidate(['model:<name>']) of a model that voted drops the cached decision",
    world: world([staticModel('m1', { votes: { 'file:read': permit() } })], { config: { cache: { ttlSeconds: 60 } } }),
    steps: [READ, READ, calls(1), { invalidate: ['model:m1'] }, READ, calls(2)],
  },
  {
    name: "one principal is never served another principal's cached decision",
    world: world([staticModel('m1', { votes: (req) => (req.principal.id === 'alice' ? permit() : {}) })], { config: { cache: { ttlSeconds: 60 } } }),
    steps: [READ, { check: { as: 'bob', permission: 'file:read', resource: f1 }, expect: { allowed: false } }, calls(2)],
  },
];

const rbacWorld: World = {
  now: NOW,
  permissions: ['file:write'],
  principals: { alice, bob },
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('editor', ['file:write'])],
    assignments: [assignment('a1', alice, 'editor', undefined, { expiresAt: later(NOW, HOUR) }), assignment('a2', bob, 'editor', undefined, { expiresAt: later(NOW, -1_000) })],
  },
};

const rbacCases: Case[] = [
  { name: "a live assignment's expiry is the decision's validUntil", steps: [{ check: { as: 'alice', permission: 'file:write', resource: f1 }, expect: { allowed: true, validUntil: later(NOW, HOUR) } }] },
  { name: 'an expired assignment contributes nothing', steps: [{ check: { as: 'bob', permission: 'file:write', resource: f1 }, expect: { allowed: false, reason: 'no_access' } }] },
];

const abacWorld: World = {
  now: NOW,
  permissions: ['file:read', 'file:write'],
  principals: { alice },
  combine: combine('deny-overrides', 'abac'),
  abac: {
    policies: [
      { id: 'old', effect: 'permit', permissions: ['file:read'], expiresAt: later(NOW, -1_000), source: 'test' },
      { id: 'live', effect: 'permit', permissions: ['file:write'], expiresAt: later(NOW, HOUR), source: 'test' },
    ],
  },
};

export const B14 = fixture('B14', [
  { name: 'core', facets: ['engine'], lanes: ['F3'], cases: core },
  { name: 'cache', facets: ['engine', 'cache', 'clock'], lanes: ['F3'], cases: cache },
  { name: 'rbac', facets: ['engine', 'rbac'], lanes: ['L1'], note: 'Link expiry: B38.rbac (`link_invalid` after `expiresAt`).', world: rbacWorld, cases: rbacCases },
  { name: 'store', facets: ['engine', 'rbac', 'store'], lanes: ['L2'], note: 'The rbac cases with the assignments in the DB store.', world: rbacWorld, cases: rbacCases },
  {
    name: 'abac',
    facets: ['engine', 'abac'],
    lanes: [],
    note: "No lane names it: L3's runBehaviour list lacks B14; L3 should add B14.abac.",
    world: abacWorld,
    cases: [
      { name: 'an expired policy contributes nothing', steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: false } }] },
      { name: "a live policy's expiry is the decision's validUntil", steps: [{ check: { as: 'alice', permission: 'file:write', resource: f1 }, expect: { allowed: true, validUntil: later(NOW, HOUR) } }] },
    ],
  },
]);
