import { InvalidArgument } from '@spinajs/exceptions';
import { QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { DbNonceStore, MemoryNonceStore, NonceStore } from '../src/index.js';
import { DB_KINDS, TestDb, bootDb, rawQuery } from './support/db.js';

const T0 = new Date('2026-06-01T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

/** One script of claims; memory and DB must answer it alike. */
async function script(store: NonceStore): Promise<boolean[]> {
  const out: boolean[] = [];
  const steps: [string, number, number][] = [
    ['a', 60, 0],
    ['a', 60, 0],
    ['a', 120, 59],
    ['b', 10, 5],
    ['a', 120, 60],
    ['a', 180, 61],
    ['b', 30, 15],
    ['c', 0, 0],
    ['c', 10, 0],
    ['c', 10, 1],
  ];
  for (const [key, expires, now] of steps) {
    out.push(await store.claim(key, at(expires), at(now)));
  }
  return out;
}

const EXPECTED_SCRIPT = [true, false, false, true, true, false, true, true, true, false];

interface Target {
  name: string;
  setup(ctx: Mocha.Context): Promise<void>;
  make(): Promise<NonceStore>;
  teardown(): Promise<void>;
}

const targets: Target[] = [
  { name: 'memory', setup: async () => undefined, make: async () => new MemoryNonceStore(), teardown: async () => undefined },
  ...DB_KINDS.map((kind): Target => {
    let db: TestDb | undefined;
    return {
      name: kind,
      setup: async (ctx) => {
        db = await bootDb(ctx, kind, 'nonce');
      },
      make: async () => {
        await rawQuery(db!.driver, 'DELETE FROM authn_nonce', [], QueryContext.Delete);
        return new DbNonceStore(db!.driver);
      },
      teardown: async () => {
        await db?.dispose();
      },
    };
  }),
];

for (const target of targets) {
  describe(`NonceStore (${target.name})`, function () {
    this.timeout(60000);

    before(async function () {
      await target.setup(this);
    });

    after(async () => {
      await target.teardown();
    });

    it('claims a key once while it is live', async () => {
      const store = await target.make();
      expect(await store.claim('jti:1', at(60), at(0))).to.eq(true);
      expect(await store.claim('jti:1', at(60), at(0))).to.eq(false);
      expect(await store.claim('jti:1', at(120), at(59))).to.eq(false);
      expect(await store.claim('jti:2', at(60), at(0))).to.eq(true);
    });

    it('lets an expired key be claimed again, once', async () => {
      const store = await target.make();
      expect(await store.claim('sig:1', at(60), at(0))).to.eq(true);
      expect(await store.claim('sig:1', at(120), at(60))).to.eq(true);
      expect(await store.claim('sig:1', at(120), at(61))).to.eq(false);
    });

    it('lets exactly one of 20 parallel claims win', async () => {
      const store = await target.make();
      const results = await Promise.all(Array.from({ length: 20 }, () => store.claim('race', at(60), at(0))));
      expect(results.filter((r) => r)).to.have.length(1);
    });

    it('lets exactly one of 20 parallel claims take over an expired key', async () => {
      const store = await target.make();
      expect(await store.claim('race-expired', at(10), at(0))).to.eq(true);
      const results = await Promise.all(Array.from({ length: 20 }, () => store.claim('race-expired', at(60), at(10))));
      expect(results.filter((r) => r)).to.have.length(1);
    });

    it('throws InvalidArgument on a key over 160 chars and on bad dates', async () => {
      const store = await target.make();
      expect(await store.claim('k'.repeat(160), at(60), at(0))).to.eq(true);
      expect(await rejection(store.claim('k'.repeat(161), at(60), at(0)))).to.be.instanceOf(InvalidArgument);
      expect(await rejection(store.claim('', at(60), at(0)))).to.be.instanceOf(InvalidArgument);
      expect(await rejection(store.claim('x', new Date(NaN), at(0)))).to.be.instanceOf(InvalidArgument);
      expect(await rejection(store.claim('x', at(60), 'now' as unknown as Date))).to.be.instanceOf(InvalidArgument);
    });

    it('answers the shared claim script like every other NonceStore', async () => {
      expect(await script(await target.make())).to.deep.eq(EXPECTED_SCRIPT);
    });
  });
}

for (const kind of DB_KINDS) {
  describe(`DbNonceStore store (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;

    before(async function () {
      db = await bootDb(this, kind, 'nonce_store');
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      await rawQuery(db.driver, 'DELETE FROM authn_nonce', [], QueryContext.Delete);
    });

    it('purges expired keys only', async () => {
      const store = new DbNonceStore(db.driver);
      await store.claim('old', at(10), at(0));
      await store.claim('edge', at(20), at(0));
      await store.claim('live', at(60), at(0));

      expect(await store.purge(at(20))).to.eq(2);

      expect(((await rawQuery(db.driver, 'SELECT k FROM authn_nonce')) as { k: string }[]).map((r) => r.k)).to.deep.eq(['live']);
    });

    it('purges now and then while claiming', async () => {
      const store = new DbNonceStore(db.driver);
      for (let i = 0; i < 100; i++) {
        await store.claim(`n${i}`, at(1), at(i < 50 ? 0 : 100));
      }
      const left = ((await rawQuery(db.driver, 'SELECT k FROM authn_nonce')) as { k: string }[]).map((r) => r.k);
      expect(left.length).to.be.lessThan(100);
      expect(left).to.include('n99');
    });

    it("resolves the Orm's default connection from its container when given no driver", async () => {
      const store = new DbNonceStore(undefined, { container: db.container });
      expect(await store.claim('via-container', at(60), at(0))).to.eq(true);
      expect(await new DbNonceStore(db.driver).claim('via-container', at(60), at(0))).to.eq(false);
    });
  });
}
