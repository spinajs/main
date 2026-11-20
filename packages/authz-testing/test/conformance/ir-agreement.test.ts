import { expect } from 'chai';
import 'mocha';
import { FALSE, TRUE } from '@spinajs/authz';
import type { Vote } from '@spinajs/authz';

import { voteTruth } from '../../src/index.js';

describe('voteTruth', () => {
  const noPermit: Vote = { model: 'rebac', permitWhen: FALSE, denyWhen: FALSE, reason: { code: 'no_access', model: 'rebac' }, cacheable: true };

  it('reads a permit as allow and a no-permit as deny', () => {
    expect(voteTruth({ ...noPermit, permitWhen: TRUE })).to.equal('allow');
    expect(voteTruth(noPermit)).to.equal('deny');
  });

  it('reads an error vote and a caveat_unknown no-permit as unknown', () => {
    expect(voteTruth({ ...noPermit, error: 'maxDepth', reason: { code: 'model_error', model: 'rebac' } })).to.equal('unknown');
    expect(voteTruth({ ...noPermit, reason: { code: 'caveat_unknown', model: 'rebac', caveats: ['c'] } })).to.equal('unknown');
  });
});
