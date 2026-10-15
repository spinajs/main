import { expect } from 'chai';
import * as scheduler from '../src/index.js';

describe('scheduler package', () => {
  it('loads the barrel', () => {
    expect(scheduler.SCHEDULER_PACKAGE).to.eq('@spinajs/scheduler');
  });
});
