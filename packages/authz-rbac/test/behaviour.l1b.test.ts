import 'mocha';

import { BEHAVIOUR_FIXTURES, runBehaviour, userPrincipal } from '@spinajs/authz-testing';
import type { BehaviourFixture, BehaviourSelector, FixtureExtension } from '@spinajs/authz-testing';

import { ConfigRuleStore, createRbacExtensions, rbacAssignmentExtension } from '../src/index.js';
import { rbacHarness } from './model/harness.js';

/*
 * L1b acceptance: every kit part tagged L1b, strict, on the RbacModel with its config rules, the
 * share links of `world.rbac.links` (lane handle rbacLinks) and the list extension (args v2).
 */

// Stopgap for RFC L1b-1: B35.conditions "subjects.when … (a principal attribute)" assumes a missing
// attribute compares false; dan gets { contractor: false } until the kit carries the change.
const SUBJECTS_WHEN = 'subjects.when selects the principals a rule applies to (a principal attribute)';
const fixtures = BEHAVIOUR_FIXTURES.map((f): BehaviourFixture | FixtureExtension => {
  if (f.id !== 'B35') return f;
  return {
    ...f,
    parts: f.parts.map((p) => (p.name !== 'conditions' ? p : { ...p, cases: p.cases.map((c) => (c.name !== SUBJECTS_WHEN || !c.world ? c : { ...c, world: { ...c.world, principals: { ...c.world.principals, dan: userPrincipal('dan', { attributes: { contractor: false } }) } } })) })),
  };
});

/** Every part of the kit tagged L1b. */
const L1B_PARTS: BehaviourSelector[] = ['B02.rules', 'B05.ladders', 'B05.rules', 'B06.rules', 'B12.implies', 'B31.ladders', 'B31.rules', 'B32.ladders', 'B32.rules', 'B33.sets', 'B34.ladders', 'B35.rules', 'B35.conditions', 'B36.rbac', 'B38.rbac', 'B42.rbac', 'B46.rules', 'B46.links'];

const harness = () =>
  rbacHarness({
    facets: ['ladders', 'rules', 'conditions', 'links'],
    rules: (host) => new ConfigRuleStore(host.world.rbac?.rules ?? []),
    extensions: (_host, model) => [...createRbacExtensions(model), rbacAssignmentExtension(model, { rules: true })],
  });

runBehaviour(L1B_PARTS, harness, { strict: true, timeoutMs: 30_000, fixtures });

// The same parts on the default extensions, where a list cannot carry rules (B06.rules needs the list extension).
const plain = () => rbacHarness({ facets: ['ladders', 'rules', 'conditions', 'links'], rules: (host) => new ConfigRuleStore(host.world.rbac?.rules ?? []) });

runBehaviour(
  L1B_PARTS.filter((p) => p !== 'B06.rules'),
  plain,
  { strict: true, timeoutMs: 30_000, fixtures },
);
