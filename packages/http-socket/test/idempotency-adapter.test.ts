import 'mocha';
import { expect } from 'chai';
import { LegacySocketStoreAdapter, MemoryIdempotencyStore, fromLegacySocketStore } from '../src/idempotency.js';
import { toStoredReply } from '../src/stored-reply.js';
import type { IdempotentReply } from '../src/interfaces.js';

const OK: IdempotentReply = { ok: true, result: { n: 1 } };
const AT = { leaseMs: 1_000, now: 0 };

describe('fromLegacySocketStore', () => {
  it('claims a free key with a fresh token and answers a held key with its 3.x state', async () => {
    const store = fromLegacySocketStore(new MemoryIdempotencyStore());

    const first = await store.claim('k', AT);
    expect(first.state).to.equal('claimed');
    expect(await store.claim('k', AT)).to.deep.equal({ state: 'running', leaseUntil: Number.MAX_SAFE_INTEGER });

    expect(await store.complete('k', (first as { token: string }).token, { kind: 'socket', body: OK }, 60_000, 0)).to.equal(true);
    expect(await store.claim('k', AT)).to.deep.equal({ state: 'done', reply: { kind: 'socket', body: OK } });
  });

  it('peeks and releases through the 3.x store', async () => {
    const legacy = new MemoryIdempotencyStore();
    const store = fromLegacySocketStore(legacy);

    expect(await store.peek('k', 0)).to.equal(undefined);
    const claim = (await store.claim('k', AT)) as { token: string };
    expect(await store.peek('k', 0)).to.deep.equal({ state: 'running', leaseUntil: Number.MAX_SAFE_INTEGER });

    await store.release('k', claim.token);
    expect(await legacy.get('k')).to.equal(null);
  });

  it('renews every claim and sweeps nothing: a 3.x claim lasts until it completes or is released', async () => {
    const legacy = new MemoryIdempotencyStore();
    const store = fromLegacySocketStore(legacy);
    const claim = (await store.claim('k', AT)) as { token: string };

    expect(await store.renew('k', claim.token, 1_000, Number.MAX_SAFE_INTEGER - 1)).to.equal(true);
    expect(await store.sweep(Number.MAX_SAFE_INTEGER, 100)).to.equal(0);
    expect(await legacy.get('k')).to.deep.equal({ state: 'running' });
  });

  it('hands the 3.x store a binary reply as binary', async () => {
    const legacy = new MemoryIdempotencyStore();
    const store = fromLegacySocketStore(legacy);
    const claim = (await store.claim('k', AT)) as { token: string };

    await store.complete('k', claim.token, toStoredReply({ ok: true, result: { data: new Uint8Array([1, 2]) } }), 60_000, 0);

    const held = (await legacy.get('k')) as { reply: { result: { data: Uint8Array } } };
    expect(held.reply.result.data).to.be.instanceOf(Uint8Array);
    expect([...held.reply.result.data]).to.deep.equal([1, 2]);
  });

  it('keeps the store it wraps', () => {
    const legacy = new MemoryIdempotencyStore();
    const store = fromLegacySocketStore(legacy);

    expect(store).to.be.instanceOf(LegacySocketStoreAdapter);
    expect((store as LegacySocketStoreAdapter).legacy).to.equal(legacy);
  });
});
