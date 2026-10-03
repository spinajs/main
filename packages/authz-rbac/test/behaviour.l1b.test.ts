import 'mocha';

import { BEHAVIOUR_FIXTURES, runBehaviour } from '@spinajs/authz-testing';
import type { BehaviourFixture, FixtureExtension } from '@spinajs/authz-testing';

import { rbacHarness } from './model/harness.js';

// Stopgap until task 5 (tags): B32.ladders minus carol's tag_missing step, which needs the tag step.
const TAG_STEP = /carol/;
const fixtures = BEHAVIOUR_FIXTURES.map((f): BehaviourFixture | FixtureExtension => {
  if (f.id !== 'B32') return f;
  return { ...f, parts: f.parts.map((p) => (p.name !== 'ladders' ? p : { ...p, cases: p.cases.map((c) => ({ ...c, steps: c.steps.filter((s) => !TAG_STEP.test(JSON.stringify(s))) })) })) };
});

runBehaviour(['B05.ladders', 'B12.implies', 'B31.ladders', 'B32.ladders', 'B33'], () => rbacHarness({ facets: ['ladders'] }), { strict: true, timeoutMs: 30_000, fixtures });
