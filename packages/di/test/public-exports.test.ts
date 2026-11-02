import 'mocha';
import { expect } from 'chai';
import * as di from '../src/index.js';

describe('the @spinajs/di root', () => {
  it('does not export the helper only the container calls', () => {
    expect(di).to.not.have.property('noteBoundSingle');
    expect(di).to.have.property('notePendingProperty');
  });
});
