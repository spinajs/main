import { expect } from 'chai';
import type { SocketError } from '@spinajs/http-socket-common';
import type { FailedOutboxEntry, OutboxEntry, OutboxStore } from '../../src/outbox.js';

export interface OutboxStoreFixture {
  /** A fresh, empty store. */
  create(): Promise<OutboxStore>;
  /** A new instance over the storage of the last `create()`. */
  reopen?(): Promise<OutboxStore>;
}

const CONFLICT: SocketError = { code: 'conflict', message: 'already there', retryable: false, retryAfterMs: 250, details: { keys: ['a', 'b'], nested: { n: 1 } }, errorId: 'err-1' };

function failedOf(entry: OutboxEntry): FailedOutboxEntry {
  return { ...entry, error: structuredClone(CONFLICT), failedAt: 1_000 };
}

/** Every OutboxStore passes this suite; `fixture` is called once per test. */
export function describeOutboxStore(title: string, fixture: () => OutboxStoreFixture, options: { reopens: boolean }): void {
  describe(`${title} (OutboxStore contract)`, () => {
    let f: OutboxStoreFixture;
    let store: OutboxStore;

    beforeEach(async () => {
      f = fixture();
      if (options.reopens && !f.reopen) {
        throw new Error(`${title}: options.reopens is true but the fixture has no reopen()`);
      }
      store = await f.create();
    });

    it('assigns increasing seqs and lists pending entries in seq order', async () => {
      const a = await store.add({ name: 'docs.submit', payload: { n: 1 } });
      const b = await store.add({ name: 'docs.submit', payload: { n: 2 } });
      const c = await store.add({ name: 'blob.put', payload: { n: 3 } });

      expect(a.seq).to.be.below(b.seq);
      expect(b.seq).to.be.below(c.seq);
      expect((await store.pending()).map((e) => e.seq)).to.deep.equal([a.seq, b.seq, c.seq]);
    });

    it('keeps the name, the payload, an app key and the creation time', async () => {
      const before = Date.now();
      const entry = await store.add({ name: 'docs.submit', payload: { op: { id: 'o1', keys: ['a', 'b'] } }, key: 'op-o1' });
      const [stored] = await store.pending();

      expect(stored).to.deep.equal(entry);
      expect(stored).to.include({ name: 'docs.submit', key: 'op-o1' });
      expect(stored.payload).to.deep.equal({ op: { id: 'o1', keys: ['a', 'b'] } });
      expect(stored.createdAt).to.be.at.least(before);
    });

    it('leaves the key out when the app gave none', async () => {
      await store.add({ name: 'x', payload: null });

      expect((await store.pending())[0]).to.not.have.property('key');
    });

    it('removes an acknowledged entry and ignores unknown seqs', async () => {
      const a = await store.add({ name: 'x', payload: 1 });
      const b = await store.add({ name: 'x', payload: 2 });

      await store.remove(a.seq);
      await store.remove(9_999);

      expect((await store.pending()).map((e) => e.seq)).to.deep.equal([b.seq]);
    });

    it('never reuses a seq, even after the newest entry was removed', async () => {
      const a = await store.add({ name: 'x', payload: 1 });
      await store.remove(a.seq);
      const b = await store.add({ name: 'x', payload: 2 });

      expect(b.seq).to.be.above(a.seq);
    });

    it('moves a pending entry to the failed list', async () => {
      const a = await store.add({ name: 'x', payload: 1 });
      const b = await store.add({ name: 'x', payload: 2 });

      await store.fail(failedOf(a));

      expect((await store.pending()).map((e) => e.seq)).to.deep.equal([b.seq]);
      expect(await store.failed()).to.deep.equal([failedOf(a)]);
    });

    it('ignores fail() for an entry that is not pending', async () => {
      const a = await store.add({ name: 'x', payload: 1 });
      await store.remove(a.seq);

      await store.fail(failedOf(a));

      expect(await store.failed()).to.deep.equal([]);
    });

    it('lists failed entries in seq order and clears some or all of them', async () => {
      const entries = [await store.add({ name: 'x', payload: 1 }), await store.add({ name: 'x', payload: 2 }), await store.add({ name: 'x', payload: 3 })];
      for (const entry of [...entries].reverse()) {
        await store.fail(failedOf(entry));
      }

      expect((await store.failed()).map((e) => e.seq)).to.deep.equal(entries.map((e) => e.seq));
      await store.clearFailed([entries[1].seq]);
      expect((await store.failed()).map((e) => e.seq)).to.deep.equal([entries[0].seq, entries[2].seq]);
      await store.clearFailed();
      expect(await store.failed()).to.deep.equal([]);
    });

    it('does not share objects with its callers', async () => {
      const added = await store.add<{ n: number; list: number[] }>({ name: 'x', payload: { n: 1, list: [1] } });
      added.payload.n = 99;
      added.payload.list.push(2);

      const [listed] = (await store.pending()) as OutboxEntry<{ n: number; list: number[] }>[];
      expect(listed.payload).to.deep.equal({ n: 1, list: [1] });
      listed.payload.n = 77;
      listed.payload.list.length = 0;

      expect((await store.pending())[0].payload).to.deep.equal({ n: 1, list: [1] });

      const failedInput = failedOf((await store.pending())[0]);
      await store.fail(failedInput);
      (failedInput.error.details as { keys: string[] }).keys.push('zzz');
      const [failed] = await store.failed();
      (failed.error.details as { keys: string[] }).keys.push('yyy');

      expect((await store.failed())[0]).to.deep.equal(failedOf({ ...listed, payload: { n: 1, list: [1] } }));
    });

    it('gives parallel adds distinct, increasing seqs', async () => {
      const added = await Promise.all(Array.from({ length: 20 }, (_, i) => store.add({ name: 'x', payload: i })));
      const seqs = added.map((e) => e.seq);

      expect(new Set(seqs).size).to.equal(20);
      expect(seqs).to.deep.equal([...seqs].sort((a, b) => a - b));
      expect((await store.pending()).map((e) => e.seq)).to.deep.equal(seqs);
    });

    it('stays consistent under concurrent add, remove and fail', async () => {
      const a = await store.add({ name: 'x', payload: 1 });
      const b = await store.add({ name: 'x', payload: 2 });
      const c = await store.add({ name: 'x', payload: 3 });

      const [d] = await Promise.all([store.add({ name: 'x', payload: 4 }), store.remove(a.seq), store.fail(failedOf(b))]);

      expect((await store.pending()).map((e) => e.seq)).to.deep.equal([c.seq, d.seq]);
      expect((await store.failed()).map((e) => e.seq)).to.deep.equal([b.seq]);
    });

    if (options.reopens) {
      it('keeps pending entries, failed entries and the seq counter across a reopen', async () => {
        const a = await store.add({ name: 'x', payload: { n: 1 }, key: 'k1' });
        const b = await store.add({ name: 'x', payload: { n: 2 } });
        const c = await store.add({ name: 'x', payload: { n: 3 } });
        await store.fail(failedOf(a));
        await store.remove(c.seq);

        const reopened = await f.reopen!();

        expect(await reopened.pending()).to.deep.equal([b]);
        expect(await reopened.failed()).to.deep.equal([failedOf(a)]);
        const d = await reopened.add({ name: 'x', payload: { n: 4 } });
        expect(d.seq).to.be.above(c.seq);
      });

      it('keeps the seq counter when the highest seq sits in the failed list', async () => {
        const a = await store.add({ name: 'x', payload: 1 });
        const b = await store.add({ name: 'x', payload: 2 });
        await store.remove(a.seq);
        await store.fail(failedOf(b));

        const reopened = await f.reopen!();

        expect((await reopened.add({ name: 'x', payload: 3 })).seq).to.be.above(b.seq);
      });

      it('keeps the seq counter when the failed list was cleared before the reopen', async () => {
        const a = await store.add({ name: 'x', payload: 1 });
        await store.fail(failedOf(a));
        await store.clearFailed();

        const reopened = await f.reopen!();

        expect((await reopened.add({ name: 'x', payload: 2 })).seq).to.be.above(a.seq);
      });

      it('persists clearFailed across a reopen', async () => {
        const a = await store.add({ name: 'x', payload: 1 });
        const b = await store.add({ name: 'x', payload: 2 });
        await store.fail(failedOf(a));
        await store.fail(failedOf(b));
        await store.clearFailed([a.seq]);

        const reopened = await f.reopen!();

        expect((await reopened.failed()).map((e) => e.seq)).to.deep.equal([b.seq]);
        await reopened.clearFailed();
        expect(await (await f.reopen!()).failed()).to.deep.equal([]);
      });
    }
  });
}
