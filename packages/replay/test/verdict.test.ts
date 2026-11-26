import 'mocha';
import { expect } from 'chai';

import { verdictOf } from '../src/index.js';
import type { ReplayOutcome } from '../src/index.js';

const outcome = (o: Partial<ReplayOutcome>): ReplayOutcome => ({ outcome: 'allow', missing: [], divergences: [], ...o });
const gap = { input: 'tuple', key: 'k1', reason: 'the authz_rebac_tuple history starts at 2026-11-20T08:00:00.000Z' };
const rehashed = { part: 'inputs-hash', recorded: 'a1', replayed: 'b2' };

describe('verdictOf', () => {
  it('is faithful when the outcome is the recorded one, with the evidence the replayer names', () => {
    expect(verdictOf('allow', outcome({}))).to.deep.equal({ replay: 'faithful', evidence: 'outcome', missing: [], divergences: [] });
    expect(verdictOf({ price: 12.5, currency: 'EUR' }, outcome({ outcome: { currency: 'EUR', price: 12.5 }, evidence: 'inputs-hash' }))).to.deep.equal({ replay: 'faithful', evidence: 'inputs-hash', missing: [], divergences: [] });
  });

  it('rule 2: a missing artifact is unreplayable, whatever else the replayer found', () => {
    const missing = [{ input: 'artifact:authz-policy', key: '9a', reason: 'no policy version is stored under the hash' }, gap];
    expect(verdictOf('allow', outcome({ missing, divergences: [{ part: 'artifact-hash', recorded: '9a', replayed: '7b' }] }))).to.deep.equal({ replay: 'unreplayable', missing, divergences: [] });
  });

  it('rule 3: an artifact that does not hash to its key is divergent, even when nothing was evaluated', () => {
    const hash = { part: 'artifact-hash', key: 'authz-policy', recorded: '9a', replayed: '7b' };
    expect(verdictOf('allow', outcome({ outcome: 'unknown', missing: [gap], divergences: [rehashed, hash] }))).to.deep.equal({ replay: 'divergent', missing: [], divergences: [hash] });
  });

  it('rule 4: an unknown outcome is unreplayable and names every gap, never divergent', () => {
    expect(verdictOf('deny', outcome({ outcome: 'unknown', missing: [gap], divergences: [rehashed] }))).to.deep.equal({ replay: 'unreplayable', missing: [gap], divergences: [] });
    expect(verdictOf('deny', outcome({ outcome: 'unknown' }))).to.deep.equal({ replay: 'unreplayable', missing: [{ input: 'evaluation', reason: 'the replay did not evaluate the recording' }], divergences: [] });
  });

  it('rule 4: an unknown outcome with missing inputs is never faithful, even when the recorded outcome is the text unknown', () => {
    expect(verdictOf('unknown', outcome({ outcome: 'unknown', missing: [gap] }))).to.deep.equal({ replay: 'unreplayable', missing: [gap], divergences: [] });
  });

  it('rule 5: another outcome is divergent on the outcome alone', () => {
    expect(verdictOf('allow', outcome({ outcome: 'deny', divergences: [rehashed] }))).to.deep.equal({ replay: 'divergent', missing: [], divergences: [{ part: 'outcome', recorded: 'allow', replayed: 'deny' }] });
    expect(verdictOf({ price: 12.5 }, outcome({ outcome: { price: 13 } })).divergences).to.deep.equal([{ part: 'outcome', recorded: '{"price":12.5}', replayed: '{"price":13}' }]);
    expect(verdictOf(undefined, outcome({ outcome: 'allow' })).divergences).to.deep.equal([{ part: 'outcome', recorded: 'undefined', replayed: 'allow' }]);
  });

  it('rule 6: the recorded outcome with a divergence the replayer reports is divergent', () => {
    const divergences = [rehashed, { part: 'captured-state', key: 'doc:1#title', recorded: '"x"', replayed: '"y"' }];
    expect(verdictOf('allow', outcome({ divergences, missing: [gap] }))).to.deep.equal({ replay: 'divergent', missing: [], divergences });
  });

  it('rule 7: a determined outcome with gaps is faithful, because ReplayOutcome asserts that no input in missing could change it', () => {
    expect(verdictOf('allow', outcome({ missing: [gap] }))).to.deep.equal({ replay: 'faithful', evidence: 'outcome', missing: [], divergences: [] });
  });
});
