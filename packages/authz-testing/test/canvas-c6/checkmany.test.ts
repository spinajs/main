import * as chai from 'chai';
import 'mocha';

import { BEHAVIOUR_FIXTURES, runBehaviour } from '../../src/index.js';
import type { BehaviourHarness, HarnessSession } from '../../src/index.js';
import { B40CheckMany, CANVAS_PAIRS, CANVAS_PERMISSIONS, checkManyAgreement } from './checkmany.js';
import { loadCanvasFixtures } from './fixtures.js';
import { canvasHarness, canvasWorld } from './harness.js';
import type { CanvasHandle, CanvasStoreKind } from './harness.js';
import { KNOWN_MISMATCHES } from './mismatches.js';

const expect = chai.expect;
const fixtures = loadCanvasFixtures();

// Hand-counted from cases.json and extra-cases.json: 64 cases ask 50 distinct pairs.
const PAIRS = 50;
const AGENT_PAIRS = 5;

async function agreeAll(harness: BehaviourHarness, store: CanvasStoreKind): Promise<{ session: HarnessSession; lines: string[]; ms: number }> {
  await harness.beforeAll?.();
  // Without 'cache' the domain has no L2, so neither path can answer from the other's stored decision.
  const facets = harness.facets.filter((f) => f !== 'cache');
  const session = await harness.setup(canvasWorld(store), { id: 'B40', part: 'checkMany', case: 'all pairs in one system', title: `canvas C6 checkMany (${store})`, facets });
  const canvas = session.lane?.canvas as CanvasHandle | undefined;
  if (!canvas || !session.authz) throw new Error('the canvas harness gave no lane handle or authz service');
  const started = Date.now();
  const lines: string[] = [];
  // The facade walk is store-independent once check and checkMany agree; on SQLite it would add a third of the time.
  const opts = { granted: store === 'memory' };
  for (const pair of CANVAS_PAIRS) lines.push(...(await checkManyAgreement(session.authz, canvas.deps, canvas.facade, pair, KNOWN_MISMATCHES[store], opts)).lines);
  return { session, lines, ms: Date.now() - started };
}

describe('canvas C6 checkMany: the distinct pairs of the cases', () => {
  it(`${PAIRS} distinct (principal, resource) pairs cover the 64 cases, ${AGENT_PAIRS} of them agents`, () => {
    expect(fixtures.cases).to.have.length(64);
    expect(CANVAS_PAIRS).to.have.length(PAIRS);
    expect(new Set(CANVAS_PAIRS.map((p) => p.key)).size).to.equal(PAIRS);
    expect(CANVAS_PAIRS.flatMap((p) => p.cases.map((c) => c.name))).to.have.members(fixtures.cases.map((c) => c.name));
    const agents = CANVAS_PAIRS.filter((p) => p.principal.kind === 'agent');
    expect(agents).to.have.length(AGENT_PAIRS);
    const agentCases = fixtures.cases.filter((c) => c.principal.kind === 'agent').map((c) => c.name);
    expect(agents.flatMap((p) => p.cases.map((c) => c.name))).to.have.members(agentCases);
  });

  it('checkMany is asked the 30 permissions in wire order', () => {
    expect(CANVAS_PERMISSIONS).to.have.length(30);
    expect(CANVAS_PERMISSIONS.slice(0, 3)).to.deep.equal(['project:read', 'project:export', 'inspect:view']);
    expect(CANVAS_PERMISSIONS.slice(-3)).to.deep.equal(['org:manage', 'org:billing', 'audit:read']);
  });
});

describe('canvas C6 checkMany equals 30 single checks (memory, one system)', function () {
  this.timeout(120000);
  const harness = canvasHarness({ store: 'memory' });
  let session: HarnessSession | undefined;

  after(async () => {
    try {
      await session?.dispose();
    } finally {
      await harness.afterAll?.();
    }
  });

  it('every pair: checkMany and check agree as engine and C6 decisions, grantedCapabilities agrees, and each case reads its expected answer from checkMany (B40)', async () => {
    const run = await agreeAll(harness, 'memory');
    session = run.session;
    console.log(`  ${CANVAS_PAIRS.length} pairs x ${CANVAS_PERMISSIONS.length} permissions in memory: ${run.lines.length} disagreement(s) (${run.ms} ms)`);
    expect(run.lines, run.lines.join('\n')).to.deep.equal([]);
  });
});

describe('canvas C6 checkMany equals 30 single checks (sqlite, one system)', function () {
  this.timeout(120000);
  const harness = canvasHarness({ store: 'sqlite' });
  let session: HarnessSession | undefined;

  after(async () => {
    try {
      await session?.dispose();
    } finally {
      await harness.afterAll?.();
    }
  });

  // The K1-2 branch cases read their pinned model_error from checkMany, and check agrees with it.
  it('every pair: checkMany and check agree as engine and C6 decisions, and each case reads its expected or K1-2 pinned answer from checkMany (B40)', async () => {
    const run = await agreeAll(harness, 'sqlite');
    session = run.session;
    console.log(`  ${CANVAS_PAIRS.length} pairs x ${CANVAS_PERMISSIONS.length} permissions on SQLite: ${run.lines.length} disagreement(s) (${run.ms} ms)`);
    expect(run.lines, run.lines.join('\n')).to.deep.equal([]);
  });
});

runBehaviour(['B40.checkMany'], () => canvasHarness({ store: 'memory' }), { strict: true, fixtures: [...BEHAVIOUR_FIXTURES, B40CheckMany] });
