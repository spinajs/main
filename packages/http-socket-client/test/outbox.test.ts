import 'mocha';
import { expect } from 'chai';
import { MemoryOutboxStore } from '../src/outbox.js';
import { describeOutboxStore } from './support/outbox-contract.js';

describeOutboxStore('MemoryOutboxStore', () => ({ create: async () => new MemoryOutboxStore() }), { reopens: false, binary: 'keeps' });

describe('MemoryOutboxStore', () => {
  it('hands out copies of its lists, so a caller cannot reorder the queue', async () => {
    const store = new MemoryOutboxStore();
    await store.add({ name: 'x', payload: 1 });

    (await store.pending()).length = 0;

    expect(await store.pending()).to.have.length(1);
  });
});
