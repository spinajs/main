import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { MemoryIdempotencyStore } from '../src/index.js';
import { describeIdempotencyStoreConformance } from '../src/testing/index.js';

describeIdempotencyStoreConformance('MemoryIdempotencyStore', () => new MemoryIdempotencyStore());

describe('MemoryIdempotencyStore', () => {
  const T = Date.parse('2026-01-01T00:00:00.000Z');
  const reply = { kind: 'test', body: null };

  async function complete(store: MemoryIdempotencyStore, key: string, ttlMs = 60_000, now = T): Promise<void> {
    const claim = await store.claim(key, { leaseMs: 1_000, now });
    if (claim.state !== 'claimed') throw new Error(`${key} was not claimed`);
    await store.complete(key, claim.token, reply, ttlMs, now);
  }

  it('drops expired replies over maxEntries before a live one', async () => {
    const store = new MemoryIdempotencyStore({ maxEntries: 2 });
    await complete(store, 'day', 86_400_000, T);
    await complete(store, 'x', 1, T);
    await complete(store, 'y', 1, T + 1);
    await complete(store, 'z', 60_000, T + 5);

    expect((await store.peek('day', T + 5))?.state).to.equal('done');
    expect((await store.peek('z', T + 5))?.state).to.equal('done');
    expect(store.Size).to.equal(2);
  });

  it('keeps the claim when the reply cannot be stored', async () => {
    const store = new MemoryIdempotencyStore();
    const claim = await store.claim('k', { leaseMs: 1_000, now: T });
    if (claim.state !== 'claimed') throw new Error('k was not claimed');

    let failed = false;
    try {
      await store.complete('k', claim.token, { kind: 'test', body: { n: 1n } }, 60_000, T);
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);
    expect(await store.peek('k', T)).to.deep.equal({ state: 'running', leaseUntil: T + 1_000 });
  });

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
