import 'mocha';
import { expect } from 'chai';
import { IdempotencyStore, MemoryIdempotencyStore, assertIdempotencyConfig } from '../src/idempotency.js';
import type { IdempotentReply } from '../src/interfaces.js';

const OK: IdempotentReply = { ok: true, result: { n: 1 } };
const FAILED: IdempotentReply = { ok: false, error: { code: 'conflict', message: 'taken', retryable: false } };

function clocked(maxEntries = 100) {
  const clock = { now: 1_000 };
  const store = new MemoryIdempotencyStore({ maxEntries }, () => clock.now);
  return { store, clock };
}

describe('MemoryIdempotencyStore', () => {
  it('is an IdempotencyStore', () => {
    expect(new MemoryIdempotencyStore()).to.be.instanceOf(IdempotencyStore);
  });

  it('claims a free key once; later claims see it running', async () => {
    const { store } = clocked();

    expect(await store.claim('k')).to.be.null;
    expect(await store.claim('k')).to.deep.equal({ state: 'running' });
    expect(await store.get('k')).to.deep.equal({ state: 'running' });
  });

  it('keeps a completed reply, for claims and gets, until its TTL passes', async () => {
    const { store, clock } = clocked();
    await store.claim('k');
    await store.complete('k', OK, 500);

    expect(await store.claim('k')).to.deep.equal({ state: 'done', reply: OK });
    clock.now += 499;
    expect(await store.get('k')).to.deep.equal({ state: 'done', reply: OK });
    clock.now += 1;
    expect(await store.get('k')).to.be.null;
    expect(await store.claim('k')).to.be.null;
  });

  it('keeps final errors like results', async () => {
    const { store } = clocked();
    await store.claim('k');
    await store.complete('k', FAILED, 500);

    expect(await store.get('k')).to.deep.equal({ state: 'done', reply: FAILED });
  });

  it('releases a running claim but never a completed one', async () => {
    const { store } = clocked();
    await store.claim('running');
    await store.claim('done');
    await store.complete('done', OK, 500);

    await store.release('running');
    await store.release('done');
    await store.release('unknown');

    expect(await store.get('running')).to.be.null;
    expect(await store.get('done')).to.deep.equal({ state: 'done', reply: OK });
  });

  it('evicts the least recently used completed keys over maxEntries, never a running claim', async () => {
    const { store } = clocked(2);
    await store.claim('busy');
    for (const key of ['a', 'b']) {
      await store.claim(key);
      await store.complete(key, OK, 10_000);
    }

    // touching 'a' makes 'b' the least recently used completed key
    await store.get('a');
    await store.claim('c');
    await store.complete('c', OK, 10_000);

    expect(await store.get('busy')).to.deep.equal({ state: 'running' });
    expect(await store.get('b')).to.be.null;
    expect(await store.get('a')).to.not.be.null;
    expect(await store.get('c')).to.not.be.null;
    expect(store.Size).to.equal(3);
  });

  it('drops expired keys on the way when it evicts', async () => {
    const { store, clock } = clocked(10);
    await store.claim('old');
    await store.complete('old', OK, 100);
    clock.now += 200;
    await store.claim('new');
    await store.complete('new', OK, 100);

    expect(store.Size).to.equal(1);
  });
});

describe('http.socket.idempotency checks', () => {
  it('refuses a missing service, a non-positive TTL and a non-integer or non-positive maxEntries', () => {
    const good = { service: 'MemoryIdempotencyStore', ttlMs: 600_000, maxEntries: 100_000 };
    expect(() => assertIdempotencyConfig(good)).not.to.throw();

    for (const bad of [{ ...good, service: '' }, { ...good, ttlMs: 0 }, { ...good, ttlMs: Number.NaN }, { ...good, ttlMs: 2 ** 31 }, { ...good, maxEntries: 0 }, { ...good, maxEntries: 1.5 }]) {
      expect(() => assertIdempotencyConfig(bad), JSON.stringify(bad)).to.throw(RangeError);
    }
  });
});
