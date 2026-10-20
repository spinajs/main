import type { CombiningAlgorithm } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { combine, fixture, permit, ref, staticModel } from './dsl.js';
import type { Case, DecisionExpectation, StaticModelSpec, World } from './types.js';

const alice = userPrincipal('alice');
const f1 = ref('file', 'f1');

// m1 fails in one of the three ways B04 names; m2 permits.
const FAILURES: Readonly<Record<string, Omit<StaticModelSpec, 'kind' | 'name'>>> = {
  throws: { throws: new Error('boom') },
  'sets error': { error: 'boom', votes: { 'file:read': permit() } },
  'exceeds modelTimeoutMs': { delayMs: Infinity, capabilities: { sync: 'never' } },
};

const MODEL_ERROR: DecisionExpectation = { allowed: false, reason: { code: 'model_error', model: 'm1' }, residual: 'FALSE' };
const ALLOWED: DecisionExpectation = { allowed: true, residual: 'TRUE' };

const world = (algorithm: CombiningAlgorithm, failure: Omit<StaticModelSpec, 'kind' | 'name'>, order: readonly ('m1' | 'm2')[]): World => ({
  permissions: ['file:read'],
  principals: { alice },
  config: { engine: { modelTimeoutMs: 50 } },
  combine: combine(algorithm, ...order),
  models: [staticModel('m1', failure), staticModel('m2', { votes: { 'file:read': permit() } })],
});

const one = (name: string, algorithm: CombiningAlgorithm, failure: Omit<StaticModelSpec, 'kind' | 'name'>, order: readonly ('m1' | 'm2')[], expect: DecisionExpectation): Case => ({
  name,
  world: world(algorithm, failure, order),
  steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect }],
});

const core = Object.entries(FAILURES).flatMap(([how, failure]): Case[] => [one(`deny-overrides: a model that ${how} denies with model_error, over a permit`, 'deny-overrides', failure, ['m1', 'm2'], MODEL_ERROR), one(`first-applicable: a first model that ${how} denies with model_error`, 'first-applicable', failure, ['m1', 'm2'], MODEL_ERROR), one(`first-applicable: a permit before a model that ${how} decides`, 'first-applicable', failure, ['m2', 'm1'], ALLOWED), one(`permit-overrides: a model that ${how} is ignored when another model permits`, 'permit-overrides', failure, ['m1', 'm2'], ALLOWED), one(`permit-overrides: a model that ${how}, alone, denies with model_error`, 'permit-overrides', failure, ['m1'], MODEL_ERROR)]);

// The ABAC deny policy reads an org attribute that is missing: the ABAC vote is indeterminate (B39).
const abacWorld = (algorithm: CombiningAlgorithm, order: readonly string[]): World => ({
  permissions: ['file:read'],
  principals: { alice },
  scopes: [
    {
      nodes: [
        { ref: ref('org', 'o1'), attributes: { policies: {} } },
        { ref: f1, parent: ref('org', 'o1') },
      ],
    },
  ],
  combine: combine(algorithm, ...order),
  models: [{ kind: 'fake-rbac', name: 'rbac', roles: { reader: ['file:read'] }, assignments: [{ subject: alice, role: 'reader' }] }],
  abac: { policies: [{ id: 'locked-orgs', effect: 'deny', permissions: ['file:read'], when: { attr: 'scope.org.policies.locked', eq: true }, source: 'test' }] },
});

const abacCase = (name: string, algorithm: CombiningAlgorithm, order: readonly string[], expect: DecisionExpectation): Case => ({
  name,
  world: abacWorld(algorithm, order),
  steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect }],
});

const ABAC_ERROR: DecisionExpectation = { allowed: false, reason: { code: 'model_error', model: 'abac' } };

export const B04 = fixture('B04', [
  {
    name: 'core',
    facets: ['engine'],
    lanes: ['F3'],
    note: '"logged at error" needs a log facet the kit does not define; the cases check the decision only.',
    cases: core,
  },
  {
    name: 'abac',
    facets: ['engine', 'abac', 'conditions'],
    lanes: ['L3'],
    note: 'An ABAC vote turns indeterminate through a missing scope attribute (B39), next to the kit FakeRbacModel (named rbac).',
    cases: [abacCase('deny-overrides: the indeterminate ABAC vote denies with model_error', 'deny-overrides', ['rbac', 'abac'], ABAC_ERROR), abacCase('permit-overrides: the indeterminate ABAC vote is ignored next to the RBAC permit', 'permit-overrides', ['rbac', 'abac'], { allowed: true }), abacCase('first-applicable: ABAC first, its indeterminate vote denies', 'first-applicable', ['abac', 'rbac'], ABAC_ERROR), abacCase('first-applicable: RBAC first, its permit decides', 'first-applicable', ['rbac', 'abac'], { allowed: true })],
  },
]);
