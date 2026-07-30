import * as chai from 'chai';
import 'mocha';
import { normalizeEnvironment } from '../src/environment.js';

const expect = chai.expect;

describe('normalizeEnvironment', () => {
  it('collapses the development aliases', () => {
    expect(normalizeEnvironment('dev')).to.equal('dev');
    expect(normalizeEnvironment('development')).to.equal('dev');
  });

  it('collapses the production aliases', () => {
    expect(normalizeEnvironment('prod')).to.equal('prod');
    expect(normalizeEnvironment('production')).to.equal('prod');
  });

  it('passes any other name through verbatim', () => {
    expect(normalizeEnvironment('local')).to.equal('local');
    expect(normalizeEnvironment('staging')).to.equal('staging');
    // case is NOT folded - `Local` and `local` are different environments
    expect(normalizeEnvironment('Local')).to.equal('Local');
  });

  it('treats absent and empty as production', () => {
    expect(normalizeEnvironment(undefined)).to.equal('prod');
    expect(normalizeEnvironment(null)).to.equal('prod');
    expect(normalizeEnvironment('')).to.equal('prod');
  });
});
