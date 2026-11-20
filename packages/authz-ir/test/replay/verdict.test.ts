import 'mocha';
import { expect } from 'chai';

import { CAVEAT_UNKNOWN, replayVerdict } from '../../src/index.js';
import type { VerdictInput } from '../../src/index.js';

const allowed = { allowed: true, cached: false };
const denied = { allowed: false, cached: false, reason: 'no_access' };
const base: VerdictInput = { recorded: allowed, blocked: [], truth: 'allow', unknowns: [] };
const v = (over: Partial<VerdictInput>) => replayVerdict({ ...base, ...over });
const policyMissing = { input: 'policy_version', key: 'h1', reason: 'no stored policy version' };

describe('replayVerdict (section 3.6)', () => {
  it('rule 1/2: anything blocked is unreplayable, named', () => {
    expect(v({ blocked: [{ input: 'resource', reason: 'type-level' }] })).to.deep.equal({ replay: 'unreplayable', missing: [{ input: 'resource', reason: 'type-level' }], divergence: [] });
    expect(v({ blocked: [policyMissing] }).missing).to.deep.equal([policyMissing]);
  });

  it('rule 3: a stored IR that does not hash to the record is divergent', () => {
    expect(v({ policyHash: { recorded: 'h1', replayed: 'h2' } })).to.deep.equal({ replay: 'divergent', missing: [], divergence: [{ part: 'policy-hash', recorded: 'h1', replayed: 'h2' }] });
  });

  it('rule 4: an unknown truth is unreplayable with what left it unknown', () => {
    const gap = { input: 'tuple', key: 'k', reason: 'a write outside the changelog' };
    expect(v({ truth: 'unknown', unknowns: [gap] })).to.deep.equal({ replay: 'unreplayable', missing: [gap], divergence: [] });
    expect(v({ truth: null }).missing).to.have.length(1);
  });

  it('rule 5: a determinate truth that differs from the record is divergent, noting a cached record', () => {
    expect(v({ truth: 'deny' })).to.deep.equal({ replay: 'divergent', missing: [], divergence: [{ part: 'outcome', recorded: 'allow', replayed: 'deny' }] });
    expect(v({ recorded: { allowed: false, cached: true }, truth: 'allow' }).divergence).to.deep.equal([{ part: 'outcome', recorded: 'deny (cached)', replayed: 'allow' }]);
  });

  it('rule 6: a recomputed inputs hash or a rebuilt captured value that differs is divergent', () => {
    expect(v({ inputsHash: { recorded: 'a', replayed: 'b' } }).divergence).to.deep.equal([{ part: 'inputs-hash', recorded: 'a', replayed: 'b' }]);
    const state = { part: 'captured-state' as const, recorded: '"open"', replayed: '"closed"', key: 'doc:1' };
    expect(v({ captured: [state] })).to.deep.equal({ replay: 'divergent', missing: [], divergence: [state] });
  });

  it('rule 7: faithful, with the evidence it rests on', () => {
    expect(v({})).to.deep.equal({ replay: 'faithful', evidence: 'outcome', missing: [], divergence: [] });
    expect(v({ inputsHash: { recorded: 'a', replayed: 'a' } }).evidence).to.equal('inputs-hash');
    expect(v({ recorded: denied, truth: 'deny' }).replay).to.equal('faithful');
  });

  it('applies the rules in order', () => {
    expect(v({ blocked: [policyMissing], truth: 'deny' }).replay, 'a missing policy version wins over an outcome mismatch').to.equal('unreplayable');
    expect(v({ blocked: [policyMissing], policyHash: { recorded: 'h1', replayed: 'h2' } }).replay).to.equal('unreplayable');
    expect(v({ truth: 'unknown', recorded: denied }).replay, 'unknown with an outcome mismatch').to.equal('unreplayable');
    expect(v({ truth: 'deny', inputsHash: { recorded: 'a', replayed: 'b' } }).divergence.map((d) => d.part)).to.deep.equal(['outcome']);
  });

  it(`reads a recorded ${CAVEAT_UNKNOWN} denial as unknown: unreplayable, never divergent`, () => {
    const recorded = { allowed: false, cached: false, reason: CAVEAT_UNKNOWN };
    for (const truth of ['unknown', 'allow', 'deny'] as const) {
      const out = v({ recorded, truth });
      expect(out.replay, truth).to.equal('unreplayable');
      expect(out.missing.map((m) => m.input)).to.include(CAVEAT_UNKNOWN);
    }
    expect(CAVEAT_UNKNOWN).to.equal('caveat_unknown');
  });
});
