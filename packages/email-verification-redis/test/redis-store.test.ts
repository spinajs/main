import { expect } from 'chai';
import { storeContract } from '@spinajs/email-verification/testing';
import { Redis } from 'ioredis';
import { bootStore, disposeStore, rawClient } from './support.js';

let shared: Awaited<ReturnType<typeof bootStore>> | undefined;

storeContract(
  'RedisEmailVerificationStore',
  async () => {
    shared ??= await bootStore();
    await rawClient().flushall();
    return shared;
  },
  {
    dispose: async () => {
      await disposeStore();
      shared = undefined;
    },
  },
);

describe('RedisEmailVerificationStore keys', () => {
  after(disposeStore);

  it('writes verdicts under the ev: prefix with a TTL', async () => {
    const store = await bootStore();
    await rawClient().flushall();
    await store.setVerdict('dns', 'a.com', { result: 'refuse', reason: 'null_mx', checkedAt: 1 }, 60);
    expect(await rawClient().pttl('ev:verdict:dns:a.com')).to.be.greaterThan(0);
  });

  it('keeps no temporary key after a replace', async () => {
    const store = await bootStore();
    await rawClient().flushall();
    await store.replaceSource('src', 'block', ['a.com', 'b.com']);
    expect((await rawClient().keys('ev:*')).sort()).to.deep.eq(['ev:internal:listVersion', 'ev:list:block:src', 'ev:lists']);
  });

  it('leaves the live list without a TTL after a replace', async () => {
    const store = await bootStore();
    await rawClient().flushall();
    await store.replaceSource('src', 'block', ['a.com']);
    expect(await rawClient().pttl('ev:list:block:src')).to.eq(-1);
  });

  it('returns null for a corrupt cached verdict', async () => {
    const store = await bootStore();
    await rawClient().flushall();
    await rawClient().set('ev:verdict:dns:a.com', '{not json');
    expect(await store.getVerdict('dns', 'a.com')).to.eq(null);
    await rawClient().set('ev:verdict:dns:b.com', JSON.stringify({ result: 'maybe', checkedAt: 1 }));
    expect(await store.getVerdict('dns', 'b.com')).to.eq(null);
  });

  it('does not let setMeta collide with the list version', async () => {
    const store = await bootStore();
    await rawClient().flushall();
    await store.upsertEntries([{ domain: 'a.com', kind: 'block', source: 'src' }]);
    await store.setMeta('listVersion', 'x');
    expect(await store.listVersion()).to.eq('1');
  });

  it('surfaces a command error from a transaction', async () => {
    const store = await bootStore();
    await rawClient().flushall();
    await rawClient().set('ev:list:block:src', 'not-a-set');
    let err: unknown;
    await store.upsertEntries([{ domain: 'a.com', kind: 'block', source: 'src' }]).catch((e: unknown) => void (err = e));
    expect(err).to.be.instanceOf(Error);
  });

  it('handles large batches', async () => {
    const store = await bootStore();
    await rawClient().flushall();
    const domains = Array.from({ length: 2500 }, (_, i) => `d${i}.com`);
    await store.upsertEntries(domains.map((domain) => ({ domain, kind: 'block' as const, source: 'src' })));
    await store.removeEntries('block', domains, 'src');
    expect(await rawClient().scard('ev:list:block:src')).to.eq(0);
  });

  it('disposes a client that never connected without hanging', async () => {
    const store = await bootStore();
    (store as unknown as { Client: Redis }).Client = new Redis({ lazyConnect: true });
    const started = Date.now();
    await store.dispose();
    expect(Date.now() - started).to.be.lessThan(500);
  });
});
