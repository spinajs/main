import 'mocha';
import { expect } from 'chai';
import { manifestToOpenApi } from '../src/index.js';

describe('@spinajs/openapi exports', () => {
  it('exposes manifestToOpenApi', () => {
    expect(manifestToOpenApi).to.be.a('function');
  });
});
