import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { MemoryIdempotencyStore } from '../src/index.js';
import { describeIdempotencyStoreConformance } from '../src/testing/index.js';

describeIdempotencyStoreConformance('MemoryIdempotencyStore', () => new MemoryIdempotencyStore());

describe('MemoryIdempotencyStore', () => {
  const T = Date.parse('2026-01-01T00:00:00.000Z');
  const reply = { kind: 'test', body: null };

  async function complete(store: MemoryIdempotencyStore, key: string): Promise<void> {
    const claim = await store.claim(key, { leaseMs: 1_000, now: T });
    if (claim.state !== 'claimed') throw new Error(`${key} was not claimed`);
    await store.complete(key, claim.token, reply, 60_000, T);
  }

  it('drops the oldest completed keys over maxEntries and never a running claim', async () => {
    const store = new MemoryIdempotencyStore({ maxEntries: 2 });
    await store.claim('busy', { leaseMs: 1_000, now: T });
    for (const key of ['a', 'b', 'c']) await complete(store, key);

    expect(await store.peek('a', T)).to.equal(undefined);
    expect((await store.peek('b', T))?.state).to.equal('done');
    expect((await store.peek('c', T))?.state).to.equal('done');
    expect((await store.peek('busy', T))?.state).to.equal('running');
    expect(store.Size).to.equal(3);
  });

  it('refuses a maxEntries that is not an integer above 0', () => {
    for (const maxEntries of [0, -1, 1.5, Number.NaN]) {
      expect(() => new MemoryIdempotencyStore({ maxEntries }), String(maxEntries)).to.throw(InvalidArgument);
    }
  });
});
