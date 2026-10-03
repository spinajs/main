import 'mocha';
import { expect } from 'chai';
import { IDBDatabase as FakeIDBDatabase, IDBFactory as FakeIDBFactory } from 'fake-indexeddb';
import * as browser from '../src/browser.js';
import { IndexedDbOutboxStore } from '../src/outbox-indexeddb.js';
import type { OutboxStore } from '../src/outbox.js';
import { closeAll } from './support/cleanup.js';
import { makeClient } from './support/client.js';
import { serveDurable } from './support/durable.js';
import { describeOutboxStore } from './support/outbox-contract.js';
import { StubServer } from './support/stub-server.js';
import { sleep, until } from './support/wait.js';

const freshIndexedDb = () => new FakeIDBFactory() as unknown as IDBFactory;

async function drained(store: OutboxStore, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while ((await store.pending()).length > 0) {
    if (Date.now() > end) {
      throw new Error(`outbox not drained within ${timeoutMs} ms`);
    }
    await sleep(20);
  }
}

describeOutboxStore(
  'IndexedDbOutboxStore',
  () => {
    const factory = freshIndexedDb();
    return { create: async () => new IndexedDbOutboxStore('contract', { factory }), reopen: async () => new IndexedDbOutboxStore('contract', { factory }) };
  },
  { reopens: true },
);

describe('IndexedDbOutboxStore', () => {
  it('keeps binary payloads, which a JSON store could not', async () => {
    const store = new IndexedDbOutboxStore('binary', { factory: freshIndexedDb() });
    await store.add({ name: 'blob.put', payload: { bytes: new Uint8Array([1, 2, 3]) } });

    const [entry] = await store.pending();

    expect(Array.from((entry.payload as { bytes: Uint8Array }).bytes)).to.deep.equal([1, 2, 3]);
  });

  it('rejects with a clear error when there is no IndexedDB', async () => {
    const error = await new IndexedDbOutboxStore('none').pending().catch((e: unknown) => e);

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain('IndexedDB');
  });

  it('is exported by the ./browser entry beside the main entry', () => {
    expect(browser.IndexedDbOutboxStore).to.equal(IndexedDbOutboxStore);
    expect(browser).to.have.property('SocketClient');
    expect(browser).to.have.property('MemoryOutboxStore');
  });

  it('isolates stores by name', async () => {
    const factory = freshIndexedDb();
    const a = new IndexedDbOutboxStore('a', { factory });
    const b = new IndexedDbOutboxStore('b', { factory });

    await a.add({ name: 'x', payload: 1 });

    expect(await a.pending()).to.have.length(1);
    expect(await b.pending()).to.deep.equal([]);
    expect(await b.failed()).to.deep.equal([]);
  });

  it('is durable without close: a second instance reads the entries while the first is open', async () => {
    const factory = freshIndexedDb();
    const first = new IndexedDbOutboxStore('open', { factory });
    const added = await first.add({ name: 'x', payload: { n: 1 } });

    const second = new IndexedDbOutboxStore('open', { factory });

    expect(await second.pending()).to.deep.equal([added]);
  });

  it('resolves add() only after its transaction completed', async () => {
    const proto = FakeIDBDatabase.prototype as unknown as { transaction: (...args: unknown[]) => IDBTransaction };
    const original = proto.transaction;
    const log: string[] = [];
    proto.transaction = function (this: unknown, ...args: unknown[]) {
      const tx = original.apply(this, args);
      tx.addEventListener('complete', () => log.push('complete'));
      return tx;
    };

    try {
      const store = new IndexedDbOutboxStore('commit', { factory: freshIndexedDb() });
      await store.add({ name: 'x', payload: 1 }).then(() => log.push('resolved'));
    } finally {
      proto.transaction = original;
    }

    // the first transaction is the schema upgrade
    expect(log.slice(-2)).to.deep.equal(['complete', 'resolved']);
  });

  it('commits nothing of an add whose payload cannot be cloned', async () => {
    const store = new IndexedDbOutboxStore('uncloneable', { factory: freshIndexedDb() });

    const error = await store.add({ name: 'x', payload: { fn: () => 1 } }).catch((e: unknown) => e);

    expect(error).to.be.instanceOf(Error);
    expect(await store.pending()).to.deep.equal([]);
    expect((await store.add({ name: 'x', payload: 1 })).seq).to.be.a('number');
  });

  it('reopens after close()', async () => {
    const store = new IndexedDbOutboxStore('reopen', { factory: freshIndexedDb() });
    const a = await store.add({ name: 'x', payload: 1 });

    await store.close();

    expect(await store.pending()).to.deep.equal([a]);
  });

  it('closes its connection on versionchange, so a newer schema is not blocked', async () => {
    const factory = freshIndexedDb();
    const store = new IndexedDbOutboxStore('upgrade', { factory });
    await store.add({ name: 'x', payload: 1 });

    const upgrade = factory.open('spinajs-outbox:upgrade', 2);
    let blocked = false;
    upgrade.onblocked = () => {
      blocked = true;
    };
    upgrade.onupgradeneeded = () => undefined;
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      upgrade.onsuccess = () => resolve(upgrade.result);
      upgrade.onerror = () => reject(upgrade.error);
    });
    upgraded.close();

    expect(blocked).to.be.false;
  });

  describe('a client recreated mid-queue ( spec §7 Durable + reload )', () => {
    let server: StubServer;

    beforeEach(async () => {
      server = new StubServer();
      await server.start();
    });

    afterEach(async () => {
      closeAll();
      await server.stop();
    });

    it('finishes the queue, running each command once and in order', async () => {
      const stub = serveDurable(server, 'docs.submit');
      server.ackFault = { kind: 'delay', ms: 30 };
      const factory = freshIndexedDb();

      const first = makeClient(server, { outbox: new IndexedDbOutboxStore('editor', { factory }), durable: { window: 4 } });
      const calls = Array.from({ length: 20 }, (_, n) => first.durable('docs.submit', { n }, { key: `op-${n}` }).catch(() => 'closed'));
      await until(() => stub.runs.size >= 6);
      // the tab closes: the replies in flight are lost, the rest was never sent
      first.close();
      expect(await Promise.all(calls)).to.include('closed');

      const reloaded = new IndexedDbOutboxStore('editor', { factory });
      expect((await reloaded.pending()).length).to.be.within(1, 19);

      server.ackFault = { kind: 'none' };
      makeClient(server, { outbox: reloaded });
      await drained(reloaded);

      expect(stub.runs.size).to.equal(20);
      expect([...stub.runs.values()].every((runs) => runs === 1)).to.be.true;
      expect(stub.order).to.deep.equal(Array.from({ length: 20 }, (_, n) => `op-${n}`));
    });
  });
});
