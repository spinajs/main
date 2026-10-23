import { expect } from 'chai';
import { Exception, LimitExceeded, isErrorOf } from '../src/index.js';

describe('LimitExceeded', () => {
  it('is an Exception named after its class that keeps its cause', () => {
    const cause = new Error('raw');
    const err = new LimitExceeded('over 5 bytes', cause);

    expect(err).to.be.instanceOf(Exception);
    expect(err.name).to.equal('LimitExceeded');
    expect(err.message).to.equal('over 5 bytes');
    expect(err.inner).to.equal(cause);
    expect(isErrorOf(err, LimitExceeded)).to.equal(true);
  });
});
