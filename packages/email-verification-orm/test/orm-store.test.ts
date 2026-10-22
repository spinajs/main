import { expect } from 'chai';
import { storeContract } from '@spinajs/email-verification/testing';
import { VERDICTS_TABLE } from '../src/tables.js';
import { bootStore, disposeStore, driver, truncate } from './support.js';

let shared: Awaited<ReturnType<typeof bootStore>> | undefined;

storeContract(
  'OrmEmailVerificationStore',
  async () => {
    shared ??= await bootStore();
    await truncate();
    return shared;
  },
  {
    dispose: async () => {
      await disposeStore();
      shared = undefined;
    },
  },
);

describe('OrmEmailVerificationStore extras', () => {
  after(disposeStore);

  it('cleanupExpired deletes expired verdicts only', async () => {
    const store = await bootStore();
    await store.setVerdict('dns', 'old.com', { result: 'unknown', checkedAt: 1 }, 1);
    await store.setVerdict('dns', 'new.com', { result: 'unknown', checkedAt: 1 }, 600);
    await new Promise((r) => setTimeout(r, 1100));
    expect(await store.cleanupExpired()).to.eq(1);
    const keys = ((await (await driver()).select().from(VERDICTS_TABLE)) as { key: string }[]).map((r) => r.key);
    expect(keys).to.deep.eq(['dns:new.com']);
  });

  it('migrates and works on the connection named by emailVerification.orm.connection', async () => {
    const store = await bootStore('other-connection');
    await store.setMeta('k', 'v');
    expect(await store.getMeta('k')).to.eq('v');
  });
});
