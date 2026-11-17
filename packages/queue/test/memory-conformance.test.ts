import { expect } from 'chai';
import { describeQueueTransportConformance } from '../src/testing/index.js';
import { memoryHarness } from './support/memory-harness.js';

describeQueueTransportConformance('MemoryQueueClient', memoryHarness);

describe('describeQueueTransportConformance', () => {
  it('refuses to skip a case that does not exist', () => {
    expect(() => describeQueueTransportConformance('typo', memoryHarness, { skip: { 'drops a failed event by defualt': 'a typo' } })).to.throw('there is no case "drops a failed event by defualt" to skip');
  });
});
