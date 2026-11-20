import * as chai from 'chai';
import 'mocha';

import { conformanceRuns } from '../../src/conformance/common.js';

const expect = chai.expect;

describe('conformanceRuns', () => {
  const saved = process.env.AUTHZ_CONFORMANCE_RUNS;
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTHZ_CONFORMANCE_RUNS;
    else process.env.AUTHZ_CONFORMANCE_RUNS = saved;
  });

  it('takes an explicit numRuns over the environment', () => {
    process.env.AUTHZ_CONFORMANCE_RUNS = '5';
    expect(conformanceRuns(40)).to.equal(40);
  });

  it('takes AUTHZ_CONFORMANCE_RUNS when numRuns is not given', () => {
    process.env.AUTHZ_CONFORMANCE_RUNS = '5';
    expect(conformanceRuns(undefined)).to.equal(5);
  });

  it('falls back to 25, or to the given fallback, without a usable value', () => {
    delete process.env.AUTHZ_CONFORMANCE_RUNS;
    expect(conformanceRuns(undefined)).to.equal(25);
    process.env.AUTHZ_CONFORMANCE_RUNS = 'many';
    expect(conformanceRuns(undefined, 60)).to.equal(60);
    process.env.AUTHZ_CONFORMANCE_RUNS = '0';
    expect(conformanceRuns(undefined)).to.equal(25);
  });
});
