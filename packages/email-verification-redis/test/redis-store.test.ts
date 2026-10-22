import { expect } from 'chai';
import { storeContract } from '@spinajs/email-verification/testing';
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
    expect((await rawClient().keys('ev:*')).sort()).to.deep.eq(['ev:list:block:src', 'ev:lists', 'ev:meta:listVersion']);
  });
});
