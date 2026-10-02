import { TRUE } from '@spinajs/authz';
import type { CombiningAlgorithm } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { cmp, combine, deny, fixture, permit, ref, staticModel } from './dsl.js';
import type { Case, StaticModelSpec, World } from './types.js';

const alice = userPrincipal('alice');
const f1 = ref('file', 'r1');
const LOCKED = cmp('status', 'eq', 'locked');

const rows = {
  file: [
    { id: 'r1', status: 'open' },
    { id: 'r2', status: 'locked' },
    { id: 'r3', status: null },
  ],
};

const PERMITS = (name: string) => staticModel(name, { votes: { 'file:read': permit() } });
const DENIES = (name: string) => staticModel(name, { votes: { 'file:read': deny() } });
const SILENT = (name: string) => staticModel(name);
const SLOW = (spec: StaticModelSpec): StaticModelSpec => ({ ...spec, delayMs: 30, capabilities: { sync: 'never' } });

const world = (algorithm: CombiningAlgorithm, models: StaticModelSpec[]): World => ({
  permissions: ['file:read'],
  principals: { alice },
  adapters: [{ types: ['file'], rows }],
  combine: combine(algorithm, ...models.map((m) => m.name)),
  models,
});

const decide = (name: string, algorithm: CombiningAlgorithm, models: StaticModelSpec[], allowed: boolean): Case => ({
  name,
  world: world(algorithm, models),
  steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: allowed ? { allowed, residual: 'TRUE' } : { allowed, residual: 'FALSE' } }],
});

const rowsOf = (name: string, algorithm: CombiningAlgorithm, models: StaticModelSpec[], selects: string[]): Case => ({
  name,
  world: world(algorithm, models),
  steps: [{ check: { as: 'alice', permission: 'file:read' }, expect: selects.length ? { allowed: true, residual: { selects } } : { allowed: false } }],
});

const SELF_DENIED = staticModel('m1', { votes: { 'file:read': { permitWhen: TRUE, denyWhen: TRUE } } });
const PERMIT_UNLESS_LOCKED = staticModel('m1', { votes: { 'file:read': permit(undefined, { denyWhen: LOCKED }) } });
const DENY_IF_LOCKED = staticModel('m1', { votes: { 'file:read': deny(undefined, LOCKED) } });

const core: Case[] = [
  decide('deny-overrides: a deny beats a permit', 'deny-overrides', [PERMITS('m1'), DENIES('m2')], false),
  decide('deny-overrides: a deny beats a permit in either config order', 'deny-overrides', [DENIES('m2'), PERMITS('m1')], false),
  decide('deny-overrides: a permit nobody denies is allowed', 'deny-overrides', [PERMITS('m1'), SILENT('m2')], true),
  decide('deny-overrides: a slow permit and a fast deny still deny', 'deny-overrides', [SLOW(PERMITS('m1')), DENIES('m2')], false),
  decide('deny-overrides: a slow deny and a fast permit still deny', 'deny-overrides', [PERMITS('m1'), SLOW(DENIES('m2'))], false),
  rowsOf('deny-overrides: a conditional deny cuts the permit row by row (UNKNOWN stays out)', 'deny-overrides', [PERMIT_UNLESS_LOCKED, PERMITS('m2')], ['r1']),

  decide("permit-overrides: a permit beats another model's deny", 'permit-overrides', [PERMITS('m1'), DENIES('m2')], true),
  decide("permit-overrides: a permit beats another model's deny in either config order", 'permit-overrides', [DENIES('m2'), PERMITS('m1')], true),
  decide('permit-overrides: a permit its own model denies does not count', 'permit-overrides', [SELF_DENIED, SILENT('m2')], false),
  decide('permit-overrides: a self-denied permit gives way to another permit', 'permit-overrides', [SELF_DENIED, PERMITS('m2')], true),
  rowsOf("permit-overrides: only a model's own deny cuts its permit", 'permit-overrides', [PERMIT_UNLESS_LOCKED, PERMITS('m2')], ['r1', 'r2', 'r3']),

  decide('first-applicable: the first model denies', 'first-applicable', [DENIES('m1'), PERMITS('m2')], false),
  decide('first-applicable: the first model permits', 'first-applicable', [PERMITS('m2'), DENIES('m1')], true),
  decide('first-applicable: a model without an opinion does not decide', 'first-applicable', [SILENT('m1'), PERMITS('m2')], true),
  decide('first-applicable: config order decides, not the order of answers', 'first-applicable', [SLOW(DENIES('m1')), PERMITS('m2')], false),
  rowsOf('first-applicable: a conditional first deny decides only the rows it holds for', 'first-applicable', [DENY_IF_LOCKED, PERMITS('m2')], ['r1']),
  {
    name: 'first-applicable: all models without an opinion is FALSE with no_access',
    world: world('first-applicable', [SILENT('m1'), SILENT('m2')]),
    steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: false, reason: 'no_access', residual: 'FALSE' } }],
  },
  {
    name: 'first-applicable: explain still evaluates every routed model',
    world: world('first-applicable', [DENIES('m1'), PERMITS('m2')]),
    steps: [{ explain: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: false, trace: { votes: ['m1', 'm2'] } } }],
  },
];

const abacWorld = (algorithm: CombiningAlgorithm, models: string[]): World => ({
  permissions: ['file:read', 'file:delete'],
  principals: { alice },
  combine: combine(algorithm, ...models),
  models: [{ kind: 'fake-rbac', name: 'rbac', roles: { editor: ['file:*'] }, assignments: [{ subject: alice, role: 'editor' }] }],
  abac: { policies: [{ id: 'no-delete', effect: 'deny', permissions: ['file:delete'], principalTypes: ['user'], reason: 'no_delete', source: 'test' }] },
});

const abacCase = (name: string, algorithm: CombiningAlgorithm, models: string[], deleteAllowed: boolean): Case => ({
  name,
  world: abacWorld(algorithm, models),
  steps: [
    { check: { as: 'alice', permission: 'file:delete', resource: f1 }, expect: { allowed: deleteAllowed } },
    { check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: true } },
  ],
});

export const B03 = fixture('B03', [
  { name: 'core', facets: ['engine'], lanes: ['F3'], note: "Residuals are evaluated against rows and subjects with SQL three-valued logic, as the kit's evaluateFilter does: NULL or a type mismatch is UNKNOWN, so NOT(deny) over a NULL cell is UNKNOWN too, and only TRUE selects a row or allows a check with a subject.", cases: core },
  {
    name: 'abac',
    facets: ['engine', 'abac'],
    lanes: ['L3'],
    note: 'The ABAC model next to the kit FakeRbacModel (named rbac) under all three algorithms.',
    cases: [abacCase('deny-overrides: an ABAC deny policy beats the RBAC permit', 'deny-overrides', ['rbac', 'abac'], false), abacCase("permit-overrides: the RBAC permit wins over the ABAC model's deny", 'permit-overrides', ['rbac', 'abac'], true), abacCase('first-applicable: ABAC first, its deny decides', 'first-applicable', ['abac', 'rbac'], false), abacCase('first-applicable: RBAC first, its permit decides', 'first-applicable', ['rbac', 'abac'], true)],
  },
]);
