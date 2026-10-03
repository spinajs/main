import 'mocha';
import { expect } from 'chai';
import { IdempotencyStore, MemoryIdempotencyStore, assertIdempotencyConfig } from '../src/idempotency.js';
import type { IdempotentReply } from '../src/interfaces.js';
import { startServer } from './harness.js';

const OK: IdempotentReply = { ok: true, result: { n: 1 } };
const FAILED: IdempotentReply = { ok: false, error: { code: 'conflict', message: 'taken', retryable: false } };

function clocked(maxEntries = 100) {
  const clock = { now: 1_000 };
  const store = new MemoryIdempotencyStore({ maxEntries }, () => clock.now);
  return { store, clock };
}

/** Counts the entries every iteration of the map visits. */
export class IdemStepCountingMap<K, V> extends Map<K, V> {
  public steps = 0;

  public *[Symbol.iterator](): MapIterator<[K, V]> {
    for (const entry of super.entries()) {
      this.steps++;
      yield entry;
    }
  }

  public *entries(): MapIterator<[K, V]> {
    yield* this[Symbol.iterator]();
  }

  public *values(): MapIterator<V> {
    for (const [, value] of this[Symbol.iterator]()) {
      yield value;
    }
  }
}

export class IdemStepCountingStore extends MemoryIdempotencyStore {
  public readonly map = new IdemStepCountingMap<string, never>();

  constructor(maxEntries: number) {
    super({ maxEntries });
    this.entries = this.map;
  }
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

  it('does not walk all its entries on every completion', async () => {
    const store = new IdemStepCountingStore(100_000);
    for (let i = 0; i < 1_000; i++) {
      await store.claim(`k${i}`);
      await store.complete(`k${i}`, OK, 10_000);
    }

    expect(store.map.steps).to.be.below(5_000);
  });

  it('keeps maxEntries completed keys after expired ones went on lookup and after a key completed twice', async () => {
    const { store, clock } = clocked(2);
    for (const key of ['a', 'b']) {
      await store.claim(key);
      await store.complete(key, OK, 100);
    }
    clock.now += 200;
    expect(await store.get('a')).to.be.null;
    expect(await store.get('b')).to.be.null;

    for (const key of ['c', 'c', 'd']) {
      await store.claim(key);
      await store.complete(key, OK, 10_000);
    }

    expect(await store.get('c')).to.not.be.null;
    expect(await store.get('d')).to.not.be.null;
    expect(store.Size).to.equal(2);
  });

  it('keeps 100 000 completed keys by default', async function () {
    this.timeout(20_000);
    const store = new MemoryIdempotencyStore();
    for (let i = 0; i <= 100_000; i++) {
      await store.complete(`k${i}`, OK, 600_000);
    }

    expect(store.Size).to.equal(100_000);
    expect(await store.get('k0')).to.be.null;
    expect(await store.get('k1')).to.not.be.null;
  });

  it('stores and returns copies, so neither the handler nor a replay can change a stored reply', async () => {
    const { store } = clocked();
    const reply = { ok: true as const, result: { items: [1] } };
    await store.claim('k');
    await store.complete('k', reply, 10_000);

    reply.result.items.push(2);
    const replayed = (await store.get('k')) as { state: 'done'; reply: { ok: true; result: { items: number[] } } };
    replayed.reply.result.items.push(3);
    const claimed = (await store.claim('k')) as { state: 'done'; reply: { ok: true; result: { items: number[] } } };
    claimed.reply.result.items.push(4);

    expect(await store.get('k')).to.deep.equal({ state: 'done', reply: { ok: true, result: { items: [1] } } });
  });

  it('gives exactly one of many concurrent claims the key', async () => {
    const { store } = clocked();
    const claims = await Promise.all(Array.from({ length: 10 }, () => store.claim('k')));

    expect(claims.filter((c) => c === null)).to.have.length(1);
    expect(claims.filter((c) => c !== null)).to.deep.equal(Array.from({ length: 9 }, () => ({ state: 'running' })));
  });

  it('refuses a maxEntries that is not an integer above 0', () => {
    for (const maxEntries of [0, -1, 1.5, Number.NaN]) {
      expect(() => new MemoryIdempotencyStore({ maxEntries }), String(maxEntries)).to.throw(RangeError);
    }
  });

  it('refuses a TTL that is not above 0 and leaves the key running', async () => {
    const { store } = clocked();
    await store.claim('k');

    for (const ttlMs of [0, -1, Number.NaN]) {
      await expect(store.complete('k', OK, ttlMs), String(ttlMs)).to.be.rejectedWith(RangeError);
    }
    expect(await store.get('k')).to.deep.equal({ state: 'running' });
  });
});

describe('http.socket.idempotency checks', () => {
  it('refuses a missing service, a non-positive TTL and a non-integer or non-positive maxEntries', () => {
    const good = { service: 'MemoryIdempotencyStore', ttlMs: 600_000, maxEntries: 100_000 };
    expect(() => assertIdempotencyConfig(good)).not.to.throw();

    for (const bad of [{ ...good, service: '' }, { ...good, ttlMs: 0 }, { ...good, ttlMs: Number.NaN }, { ...good, ttlMs: 2 ** 31 }, { ...good, ttlMs: Number.POSITIVE_INFINITY }, { ...good, ttlMs: -1 }, { ...good, maxEntries: 0 }, { ...good, maxEntries: -1 }, { ...good, maxEntries: Number.NaN }, { ...good, maxEntries: 1.5 }]) {
      expect(() => assertIdempotencyConfig(bad), String(bad.ttlMs) + ' ' + String(bad.maxEntries)).to.throw(RangeError);
    }
  });

  it('fails the server start on a bad idempotency config', async () => {
    await expect(startServer({ http: { socket: { idempotency: { ttlMs: -1 } } } })).to.be.rejectedWith(RangeError, 'http.socket.idempotency.ttlMs');
  });
});
