import { expect } from 'chai';
import { storeContract } from '@spinajs/email-verification/testing';
import { CHUNK_BYTES } from '../src/index.js';
import { bootStore, disposeStore, fake } from './support.js';

let shared: Awaited<ReturnType<typeof bootStore>> | undefined;

storeContract(
  'DynamoDbEmailVerificationStore',
  async () => {
    shared ??= await bootStore();
    fake.items.clear();
    return shared;
  },
  {
    dispose: async () => {
      await disposeStore();
      shared = undefined;
    },
  },
);

describe('DynamoDbEmailVerificationStore table', () => {
  after(disposeStore);

  it('creates the table keyed by pk and enables TTL on ExpiresAt', async () => {
    await bootStore();
    expect(fake.tableExists).to.eq(true);
    expect(fake.ttlAttribute).to.eq('ExpiresAt');
  });

  it('creates nothing when createTable is false', async () => {
    await bootStore({ createTable: false });
    expect(fake.sent.map((s) => s.command)).to.not.include('CreateTableCommand');
  });

  it('splits a large source into chunks under CHUNK_BYTES', async () => {
    const store = await bootStore();
    await store.replaceSource('big', 'block', Array.from({ length: 20000 }, (_, i) => `domain-${i}.example.com`));
    const chunks = [...fake.items.values()].filter((item) => item.pk.S!.startsWith('C#'));
    expect(chunks.length).to.be.greaterThan(1);
    for (const c of chunks) expect(Buffer.byteLength(c.Domains.S!)).to.be.at.most(CHUNK_BYTES);
  });

  it('leaves no chunk of an old generation behind', async () => {
    const store = await bootStore();
    await store.replaceSource('src', 'block', ['a.com']);
    await store.replaceSource('src', 'block', ['b.com']);
    expect([...fake.items.keys()].filter((k) => k.startsWith('C#'))).to.have.length(1);
  });
});
