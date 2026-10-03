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
  { reopens: true, binary: 'keeps' },
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

  it('opens again after a versionchange closed its connection', async () => {
    const factory = freshIndexedDb();
    const store = new IndexedDbOutboxStore('after-change', { factory });
    const a = await store.add({ name: 'x', payload: 1 });

    // a same-version connection stands in for another tab; versionchange is fired by a higher-version open
    const bump = factory.open('spinajs-outbox:after-change', 2);
    bump.onupgradeneeded = () => undefined;
    await new Promise((resolve, reject) => {
      bump.onsuccess = resolve;
      bump.onerror = () => reject(bump.error);
    });
    bump.result.close();

    // the store was closed by versionchange; the database is now v2, which this v1 code explains instead of crashing on
    const error = await store.pending().catch((e: unknown) => e);
    expect((error as Error).message).to.contain('newer version');
    expect(a.seq).to.be.a('number');
  });

  describe('failures', () => {
    type Tx = { transaction: (...args: unknown[]) => unknown };
    const proto = FakeIDBDatabase.prototype as unknown as Tx;
    let original: Tx['transaction'];

    beforeEach(() => {
      original = proto.transaction;
    });
    afterEach(() => {
      proto.transaction = original;
    });

    it('rejects when the transaction aborts without an error', async () => {
      const store = new IndexedDbOutboxStore('aborted', { factory: freshIndexedDb() });
      await store.pending();
      proto.transaction = function (this: unknown, ...args: unknown[]) {
        const tx = original.apply(this, args) as IDBTransaction;
        queueMicrotask(() => tx.abort());
        return tx;
      };

      const error = await store.add({ name: 'x', payload: 1 }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.contain('aborted');
    });

    it('wraps a quota failure as an "outbox is full" error with the cause', async () => {
      const store = new IndexedDbOutboxStore('quota', { factory: freshIndexedDb() });
      await store.pending();
      const quota = new DOMException('no space', 'QuotaExceededError');
      proto.transaction = function (this: unknown, ...args: unknown[]) {
        const tx = original.apply(this, args) as IDBTransaction;
        const fake = { error: quota, objectStore: (n: string) => tx.objectStore(n), abort: () => undefined } as unknown as IDBTransaction & { onabort: () => void };
        setTimeout(() => fake.onabort(), 0);
        return fake;
      };

      const error = (await store.add({ name: 'x', payload: 1 }).catch((e: unknown) => e)) as Error;

      expect(error.message).to.contain('outbox is full');
      expect(error.cause).to.equal(quota);
    });

    it('explains a NotFoundError from the transaction', async () => {
      const store = new IndexedDbOutboxStore('notfound', { factory: freshIndexedDb() });
      await store.pending();
      proto.transaction = () => {
        throw new DOMException('no store', 'NotFoundError');
      };

      const error = (await store.pending().catch((e: unknown) => e)) as Error;

      expect(error.message).to.contain('object store');
    });

    it('survives a connection closed behind its back', async () => {
      const store = new IndexedDbOutboxStore('closed', { factory: freshIndexedDb() });
      const a = await store.add({ name: 'x', payload: 1 });
      (await (store as unknown as { db: Promise<IDBDatabase> }).db).close();

      expect(await store.pending()).to.deep.equal([a]);
    });
  });

  describe('database validation', () => {
    it('rejects a database that lacks the outbox stores', async () => {
      const factory = freshIndexedDb();
      const request = factory.open('spinajs-outbox:broken', 1);
      await new Promise((resolve) => {
        request.onsuccess = resolve;
      });
      request.result.close();

      const error = (await new IndexedDbOutboxStore('broken', { factory }).pending().catch((e: unknown) => e)) as Error;

      expect(error.message).to.contain('missing object stores');
    });

    it('explains a database written by a newer version', async () => {
      const factory = freshIndexedDb();
      const request = factory.open('spinajs-outbox:newer', 5);
      await new Promise((resolve) => {
        request.onsuccess = resolve;
      });
      request.result.close();

      const error = (await new IndexedDbOutboxStore('newer', { factory }).pending().catch((e: unknown) => e)) as Error;

      expect(error.message).to.contain('newer version');
    });
  });

  describe('one live client per name', () => {
    const held = new Set<string>();
    const locks = {
      request: async (name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) => {
        if (held.has(name)) {
          return callback(null);
        }
        held.add(name);
        try {
          return await callback({ name });
        } finally {
          held.delete(name);
        }
      },
    };
    let descriptor: PropertyDescriptor | undefined;

    beforeEach(() => {
      held.clear();
      descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true, writable: true });
    });
    afterEach(() => {
      if (descriptor) {
        Object.defineProperty(globalThis, 'navigator', descriptor);
      } else {
        delete (globalThis as { navigator?: unknown }).navigator;
      }
    });

    it('refuses a second store on the same name while the first lives, and allows it after close()', async () => {
      const factory = freshIndexedDb();
      const first = new IndexedDbOutboxStore('tabs', { factory, exclusive: true });
      await first.pending();

      const second = new IndexedDbOutboxStore('tabs', { factory, exclusive: true });
      const error = (await second.pending().catch((e: unknown) => e)) as Error;
      expect(error.message).to.contain('already open');

      await first.close();
      expect(await second.pending()).to.deep.equal([]);
      await second.close();
    });

    it('does not mix up different names', async () => {
      const factory = freshIndexedDb();
      const a = new IndexedDbOutboxStore('one', { factory, exclusive: true });
      const b = new IndexedDbOutboxStore('two', { factory, exclusive: true });

      expect(await a.pending()).to.deep.equal([]);
      expect(await b.pending()).to.deep.equal([]);
      await Promise.all([a.close(), b.close()]);
    });
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
