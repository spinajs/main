import * as chai from 'chai';
import type { CachedVerdict, EmailVerificationStore, ListEntry } from '../contracts.js';

const { expect } = chai;

export interface StoreContractOptions {
  dispose?: () => Promise<void>;
}

const keys = (entries: ListEntry[]) => entries.map((e) => `${e.kind}|${e.source}|${e.domain}`).sort();
const domainsOf = (entries: ListEntry[], kind: string, source: string) =>
  entries
    .filter((e) => e.kind === kind && e.source === source)
    .map((e) => e.domain)
    .sort();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const range = (count: number, name: (i: number) => string) => Array.from({ length: count }, (_, i) => name(i));

/** The EmailVerificationStore contract; `makeStore` must return an empty store each time. */
export function storeContract(title: string, makeStore: () => Promise<EmailVerificationStore>, options: StoreContractOptions = {}): void {
  describe(title, function () {
    this.timeout(30000);

    let store: EmailVerificationStore;
    beforeEach(async () => {
      store = await makeStore();
    });
    if (options.dispose) after(options.dispose);

    describe('verdicts', () => {
      const refused: CachedVerdict = { result: 'refuse', reason: 'null_mx', source: 'http:p1', checkedAt: 1_700_000_000_000 };

      it('returns null for a verdict never stored', async () => {
        expect(await store.getVerdict('dns', 'a.com')).to.eq(null);
      });

      it('round-trips a verdict', async () => {
        await store.setVerdict('dns', 'a.com', refused, 60);
        expect(await store.getVerdict('dns', 'a.com')).to.deep.include({ result: 'refuse', reason: 'null_mx', source: 'http:p1', checkedAt: 1_700_000_000_000 });
      });

      it('round-trips a verdict without reason or source', async () => {
        await store.setVerdict('dns', 'a.com', { result: 'unknown', checkedAt: 1_700_000_000_000 }, 60);
        const got = await store.getVerdict('dns', 'a.com');
        expect(got?.result).to.eq('unknown');
        expect(got?.reason).to.eq(undefined);
        expect(got?.source).to.eq(undefined);
      });

      it('keeps the verdicts of different verifiers apart', async () => {
        await store.setVerdict('dns', 'a.com', refused, 60);
        await store.setVerdict('rdap', 'a.com', { result: 'unknown', reason: 'registered', checkedAt: 1 }, 60);
        expect((await store.getVerdict('dns', 'a.com'))?.result).to.eq('refuse');
        expect((await store.getVerdict('rdap', 'a.com'))?.reason).to.eq('registered');
      });

      it('overwrites a verdict', async () => {
        await store.setVerdict('dns', 'a.com', refused, 60);
        await store.setVerdict('dns', 'a.com', { result: 'unknown', reason: 'resolves', checkedAt: 2 }, 60);
        expect((await store.getVerdict('dns', 'a.com'))?.reason).to.eq('resolves');
      });

      it('stores nothing for a TTL of 0', async () => {
        await store.setVerdict('dns', 'a.com', refused, 0);
        expect(await store.getVerdict('dns', 'a.com')).to.eq(null);
      });

      it('drops a verdict once its TTL passed', async () => {
        await store.setVerdict('dns', 'a.com', refused, 1);
        await sleep(1100);
        expect(await store.getVerdict('dns', 'a.com')).to.eq(null);
      });
    });

    describe('lists', () => {
      it('loads nothing from an empty store', async () => {
        expect(await store.loadLists()).to.deep.eq([]);
      });

      it('upserts and loads entries', async () => {
        await store.upsertEntries([
          { domain: 'a.com', kind: 'block', source: 'admin' },
          { domain: 'b.com', kind: 'allow', source: 'admin' },
          { domain: 'mx.c.com', kind: 'block-mx', source: 'admin' },
        ]);
        expect(keys(await store.loadLists())).to.deep.eq(['allow|admin|b.com', 'block-mx|admin|mx.c.com', 'block|admin|a.com']);
      });

      it('keeps one copy of an entry upserted twice', async () => {
        await store.upsertEntries([{ domain: 'a.com', kind: 'block', source: 'admin' }]);
        await store.upsertEntries([{ domain: 'a.com', kind: 'block', source: 'admin' }]);
        expect(keys(await store.loadLists())).to.deep.eq(['block|admin|a.com']);
      });

      it('removes entries of one kind and source only', async () => {
        await store.upsertEntries([
          { domain: 'a.com', kind: 'block', source: 'admin' },
          { domain: 'a.com', kind: 'allow', source: 'admin' },
        ]);
        await store.replaceSource('sync1', 'block', ['a.com']);
        await store.removeEntries('block', ['a.com'], 'admin');
        expect(keys(await store.loadLists())).to.deep.eq(['allow|admin|a.com', 'block|sync1|a.com']);
      });

      it('replaceSource swaps the whole set of a source', async () => {
        await store.replaceSource('src', 'block', ['a.com', 'b.com']);
        await store.replaceSource('src', 'block', ['c.com']);
        expect(keys(await store.loadLists())).to.deep.eq(['block|src|c.com']);
      });

      it('replaceSource leaves other sources and kinds alone', async () => {
        await store.upsertEntries([{ domain: 'x.com', kind: 'block', source: 'admin' }]);
        await store.replaceSource('src', 'allow', ['z.com']);
        await store.replaceSource('src', 'block', ['a.com']);
        expect(keys(await store.loadLists())).to.deep.eq(['allow|src|z.com', 'block|admin|x.com', 'block|src|a.com']);
      });

      it('replaceSource with no domains removes the source', async () => {
        await store.replaceSource('src', 'block', ['a.com']);
        await store.replaceSource('src', 'block', []);
        expect(await store.loadLists()).to.deep.eq([]);
      });

      it('replaces a source of 20000 domains', async () => {
        const domains = range(20000, (i) => `domain-${i}.example.com`);
        await store.replaceSource('big', 'block', domains);
        expect(domainsOf(await store.loadLists(), 'block', 'big')).to.deep.eq([...domains].sort());
      });

      it('a reader during replaceSource sees the old set or the new set', async () => {
        const before = range(1000, (i) => `o${i}.com`).sort();
        const after = range(1000, (i) => `n${i}.com`).sort();
        await store.replaceSource('src', 'block', before);
        const writing = store.replaceSource('src', 'block', after);
        const seen: string[][] = [];
        for (let i = 0; i < 5; i++) seen.push(domainsOf(await store.loadLists(), 'block', 'src'));
        await writing;
        seen.push(domainsOf(await store.loadLists(), 'block', 'src'));
        for (const domains of seen) expect([before, after]).to.deep.include(domains);
        expect(seen[seen.length - 1]).to.deep.eq(after);
      });

      it('changes listVersion on every list write', async () => {
        const versions = [await store.listVersion()];
        await store.upsertEntries([{ domain: 'a.com', kind: 'block', source: 'admin' }]);
        versions.push(await store.listVersion());
        await store.removeEntries('block', ['a.com'], 'admin');
        versions.push(await store.listVersion());
        await store.replaceSource('src', 'block', ['b.com']);
        versions.push(await store.listVersion());
        expect(new Set(versions).size).to.eq(4);
      });
    });

    describe('meta', () => {
      it('returns null for an unknown key', async () => {
        expect(await store.getMeta('nope')).to.eq(null);
      });

      it('round-trips and overwrites a value', async () => {
        await store.setMeta('sync:a:etag', '"v1"');
        await store.setMeta('sync:a:etag', '"v2"');
        expect(await store.getMeta('sync:a:etag')).to.eq('"v2"');
      });
    });
  });
}
