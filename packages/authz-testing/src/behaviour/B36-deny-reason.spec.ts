import { FALSE, TRUE } from '@spinajs/authz';
import type { CombiningAlgorithm, DenyReason } from '@spinajs/authz';

import type { ScriptedVote } from '../fakes/index.js';
import { servicePrincipal, userPrincipal, withCeiling } from '../principals.js';
import { cmp, combine, fixture, ref, staticModel } from './dsl.js';
import type { Case, ReasonExpectation, StaticModelSpec, World } from './types.js';

const alice = userPrincipal('alice');
const f1 = ref('file', 'f1');

/** A model that denies file:read with one `denies` entry per reason. */
const denying = (name: string, ...reasons: DenyReason[]): StaticModelSpec => staticModel(name, { votes: { 'file:read': { denies: reasons.map((reason) => ({ when: TRUE, reason })) } } });
/** A model that does not permit and says why. */
const declining = (name: string, reason: DenyReason): StaticModelSpec => staticModel(name, { votes: { 'file:read': { reason } } });

const world = (algorithm: CombiningAlgorithm, models: StaticModelSpec[]): World => ({
  permissions: ['file:read'],
  principals: { alice },
  combine: combine(algorithm, ...models.map((m) => m.name)),
  models,
});

const reported = (name: string, algorithm: CombiningAlgorithm, models: StaticModelSpec[], reason: ReasonExpectation): Case => ({
  name,
  world: world(algorithm, models),
  steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: false, reason } }],
});

/** The same case with the model order reversed. */
const bothOrders = (name: string, algorithm: CombiningAlgorithm, models: StaticModelSpec[], reason: ReasonExpectation): Case[] => [reported(`${name}`, algorithm, models, reason), reported(`${name} (models reversed)`, algorithm, [...models].reverse(), reason)];

const ROLE_TOO_LOW = { code: 'role_too_low', ladder: 'project', role: 'viewer', needed: 'editor' };

const core: Case[] = [
  ...bothOrders('deny-overrides: the lowest priority wins', 'deny-overrides', [denying('m1', { code: 'slow', priority: 300 }), denying('m2', { code: 'fast', priority: 100 })], 'fast'),
  ...bothOrders('deny-overrides: equal priorities, the lowest sortKey wins', 'deny-overrides', [denying('m1', { code: 'b_rule', priority: 300, sortKey: 'b' }), denying('m2', { code: 'a_rule', priority: 300, sortKey: 'a' })], { code: 'a_rule', sortKey: 'a' }),
  ...bothOrders('deny-overrides: equal priority and sortKey, the code decides', 'deny-overrides', [denying('m1', { code: 'zulu', priority: 300 }), denying('m2', { code: 'alpha', priority: 300 })], 'alpha'),
  ...bothOrders('default priorities: no_access (400) beats role_too_low (410)', 'deny-overrides', [declining('m1', ROLE_TOO_LOW), declining('m2', { code: 'no_access' })], 'no_access'),
  ...bothOrders("a model's non-permit reason competes with deny entries, payload included", 'deny-overrides', [declining('m1', { code: 'tag_missing', tag: 'beta' }), denying('m2', { code: 'blocked' })], { code: 'tag_missing', tag: 'beta' }),
  ...bothOrders('permit-overrides: the lowest reason among the denials', 'permit-overrides', [declining('m1', ROLE_TOO_LOW), denying('m2', { code: 'blocked', priority: 100 })], 'blocked'),
  reported(
    'a deny entry whose when does not hold does not count',
    'deny-overrides',
    [
      staticModel('m1', {
        votes: {
          'file:read': {
            denyWhen: TRUE,
            denies: [
              { when: FALSE, reason: { code: 'never', priority: 1 } },
              { when: TRUE, reason: { code: 'real', priority: 300 } },
            ],
          },
        },
      }),
    ],
    'real',
  ),
  {
    name: 'deny-overrides evaluates every routed model: a later model reports the lower priority',
    world: world('deny-overrides', [denying('m1', { code: 'first', priority: 500 }), denying('m2', { code: 'second', priority: 100 })]),
    steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: false, reason: 'second' } }, { calls: { model: 'm1', count: 1 } }, { calls: { model: 'm2', count: 1 } }],
  },
  reported('the payload of the winning reason is reported', 'deny-overrides', [declining('m1', ROLE_TOO_LOW)], ROLE_TOO_LOW),
  ...coreVsModel(),
];

// D-F5-1: core reasons (ceiling and delegate, 200) compete with model reasons like any other, so a
// core denial does not stop the models from being asked for theirs (design §7 line 1529 is an erratum).
function coreVsModel(): Case[] {
  const capped = withCeiling(alice, { permissions: ['file:write'], reason: 'out_of_scope' });
  const svc = servicePrincipal('svc', { onBehalfOf: userPrincipal('u1'), delegation: 'intersect' });
  const ceilingCase = (name: string, reason: DenyReason, expected: string): Case => ({
    name,
    world: { ...world('deny-overrides', [denying('m1', reason)]), principals: { capped } },
    steps: [{ check: { as: 'capped', permission: 'file:read', resource: f1 }, expect: { allowed: false, reason: expected, residual: 'FALSE' } }],
  });
  // svc's model permits except on closed rows, where it denies with priority 100; u1 has no permit.
  const svcVote: ScriptedVote = { permitWhen: TRUE, denies: [{ when: cmp('status', 'eq', 'closed'), reason: { code: 'agents_disabled', priority: 100 } }] };
  const delegateWorld: World = {
    permissions: ['file:read'],
    principals: { svc },
    adapters: [
      {
        types: ['file'],
        rows: {
          file: [
            { id: 'open1', status: 'open' },
            { id: 'closed1', status: 'closed' },
          ],
        },
      },
    ],
    combine: combine('deny-overrides', 'm1'),
    models: [staticModel('m1', { votes: (req) => (req.principal.id === 'svc' ? svcVote : {}) })],
  };
  return [
    ceilingCase('a ceiling deny (200) beats a model deny of default priority (500)', { code: 'blocked' }, 'out_of_scope'),
    ceilingCase('a model deny with priority 100 beats the ceiling (200)', { code: 'agents_disabled', priority: 100 }, 'agents_disabled'),
    {
      name: "a model deny with priority 100 beats the core's delegate deny (200)",
      world: delegateWorld,
      steps: [
        { check: { as: 'svc', permission: 'file:read', resource: ref('file', 'closed1'), subject: 'row' }, expect: { allowed: false, reason: 'agents_disabled' } },
        { check: { as: 'svc', permission: 'file:read', resource: ref('file', 'open1'), subject: 'row' }, expect: { allowed: false, reason: 'delegate' } },
      ],
    },
    {
      // The order of evaluation never changes the reason (§7): the delegate is asked even though svc's own answer is already no.
      name: "the core's delegate deny (200) beats the principal's own no_access (400)",
      world: { ...delegateWorld, models: [staticModel('m1', { votes: (req) => (req.principal.id === 'svc' ? { reason: { code: 'no_access' } } : {}) })] },
      steps: [{ check: { as: 'svc', permission: 'file:read', resource: ref('file', 'open1') }, expect: { allowed: false, reason: 'delegate' } }],
    },
  ];
}

const abacWorld = (reversed: boolean): World => {
  const policies = [
    { id: 'agents', effect: 'deny' as const, permissions: ['file:read'], reason: 'agents_disabled', priority: 100, source: 'test' },
    { id: 'blocked', effect: 'deny' as const, permissions: ['file:read'], reason: 'blocked', source: 'test' },
  ];
  return { permissions: ['file:read'], principals: { alice }, combine: combine('deny-overrides', 'abac'), abac: { policies: reversed ? policies.reverse() : policies } };
};

export const B36 = fixture('B36', [
  { name: 'core', facets: ['engine'], lanes: ['F3'], cases: core },
  {
    name: 'abac',
    facets: ['engine', 'abac'],
    lanes: ['L3'],
    cases: [
      { name: 'the deny policy with the lowest priority is reported', world: abacWorld(false), steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: false, reason: 'agents_disabled' } }] },
      { name: 'the deny policy with the lowest priority is reported in any policy order', world: abacWorld(true), steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: false, reason: 'agents_disabled' } }] },
    ],
  },
  { name: 'rbac', facets: ['engine', 'rbac', 'ladders', 'rules'], lanes: ['L1b'], note: 'Failing RBAC rules and their priorities: with the rule fixtures of B35, or from L1b by RFC.', cases: [] },
]);
