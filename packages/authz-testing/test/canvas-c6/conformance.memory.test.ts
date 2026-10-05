import * as chai from 'chai';
import 'mocha';

import { BEHAVIOUR_FIXTURES, runBehaviour } from '../../src/index.js';
import type { HarnessSession } from '../../src/index.js';
import type { Capability } from './c6/access.js';
import type { Authz, Decision, Principal, Resource } from './c6/authz.js';
import { B40Memory, B42Canvas, B46Canvas, canvasConformance, judgeConformance } from './conformance.js';
import { loadCanvasFixtures } from './fixtures.js';
import { canvasHarness, canvasWorld } from './harness.js';
import { KNOWN_MISMATCHES } from './mismatches.js';

const expect = chai.expect;
const fixtures = loadCanvasFixtures();

describe('canvas C6 conformance (memory)', function () {
  this.timeout(60000);
  const harness = canvasHarness({ store: 'memory' });
  let session: HarnessSession | undefined;

  before(async () => {
    await harness.beforeAll?.();
    session = await harness.setup(canvasWorld('memory'), { id: 'B40', part: 'memory', case: 'all cases in one system', title: 'canvas C6 conformance (memory)', facets: [...harness.facets] });
  });

  after(async () => {
    try {
      await session?.dispose();
    } finally {
      await harness.afterAll?.();
    }
  });

  it('runs 62 vendored and 2 pinned cases', () => {
    expect(fixtures.cases).to.have.length(64);
    expect(fixtures.cases.filter((c) => c.pending !== undefined).map((c) => c.decision)).to.deep.equal(['H21', 'H27']);
  });

  it('every case answers as canvas expects, or as its known mismatch is pinned (B40)', async () => {
    const canvas = session?.lane?.canvas;
    expect(canvas, 'canvas lane handle').to.not.equal(undefined);
    const result = await canvasConformance(canvas!.facade, fixtures.cases);
    const verdict = judgeConformance(result, KNOWN_MISMATCHES.memory);
    for (const line of result.failures) console.log(`  mismatch: ${line}`);
    const known = verdict.known.length > 0 ? verdict.known.join(', ') : 'none';
    console.log(`  ${verdict.conform}/${verdict.cases} conform; known mismatches: ${known}`);
    expect(verdict.unexpected).to.deep.equal([]);
    expect(verdict.conform + verdict.known.length).to.equal(64);
  });
});

describe('canvas C6 conformance judging', () => {
  const ALLOW: Decision = { allowed: true, role: 'viewer' };
  const DENY: Decision = { allowed: false, reason: { code: 'no_access' } };
  const cases = fixtures.cases.slice(0, 3);
  const answers = (list: (Decision | Error)[]): Authz => {
    const byName = new Map(cases.map((c, i) => [c.name, list[i]]));
    return {
      can: async (p: Principal, cap: Capability, r: Resource) => {
        const c = cases.find((x) => x.principal === p && x.capability === cap && x.resource === r)!;
        const a = byName.get(c.name)!;
        if (a instanceof Error) throw a;
        return a;
      },
    };
  };

  it('writes one line per mismatch and per throw, in the canvas format', async () => {
    const r = await canvasConformance(answers([cases[0].expected, DENY, new Error('boom')]), cases);
    expect(r.cases).to.equal(3);
    expect(r.failures).to.deep.equal([`${cases[1].name}: expected ${JSON.stringify(cases[1].expected)}, got ${JSON.stringify(DENY)}`, `${cases[2].name}: expected ${JSON.stringify(cases[2].expected)}, threw Error: boom`]);
  });

  it('a known mismatch passes only with its pinned answer, and fails once it conforms or names no case', async () => {
    const r = await canvasConformance(answers([cases[0].expected, DENY, cases[2].expected]), cases);
    const pinned = judgeConformance(r, { [cases[1].name]: { rfc: 'K1-0', got: DENY } });
    expect(pinned).to.deep.equal({ conform: 2, cases: 3, unexpected: [], known: [`${cases[1].name} (K1-0)`] });
    expect(judgeConformance(r, { [cases[1].name]: { rfc: 'K1-0', got: ALLOW } }).unexpected).to.have.length(1);
    expect(judgeConformance(r, { [cases[0].name]: { rfc: 'K1-0', got: DENY } }).unexpected).to.have.length(2);
    expect(judgeConformance(r, { nothing: { rfc: 'K1-0', got: DENY } }).unexpected).to.include('nothing: known mismatch K1-0 names no case');
  });
});

runBehaviour(['B40.memory', 'B42.canvas', 'B46.canvas'], () => canvasHarness({ store: 'memory' }), { strict: true, fixtures: [...BEHAVIOUR_FIXTURES, B40Memory, B42Canvas, B46Canvas] });
