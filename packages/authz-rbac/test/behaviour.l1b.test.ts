import 'mocha';

import { BEHAVIOUR_FIXTURES, runBehaviour, userPrincipal } from '@spinajs/authz-testing';
import type { BehaviourFixture, FixtureExtension } from '@spinajs/authz-testing';

import { ConfigRuleStore } from '../src/index.js';
import { rbacHarness } from './model/harness.js';

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

const harness = () => rbacHarness({ facets: ['ladders', 'rules', 'conditions'], rules: (host) => new ConfigRuleStore(host.world.rbac?.rules ?? []) });

runBehaviour(['B02.rules', 'B05.ladders', 'B05.rules', 'B12.implies', 'B31', 'B32', 'B33', 'B34', 'B35', 'B36.rbac', 'B46.rules'], harness, { strict: true, timeoutMs: 30_000, fixtures });
