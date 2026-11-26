import * as chai from 'chai';
import 'mocha';
import { AsyncResource } from 'node:async_hooks';
import { SYSTEM } from '@spinajs/authz';
import type { AdminCallContext, AuthzService } from '@spinajs/authz';
import { CHANGE_LOG_TABLE } from '@spinajs/authz-orm/changelog';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, WriteStatement } from '@spinajs/orm';

import { tupleChanged } from '../../src/admin/common.js';
import { AUTHZ_REBAC_TUPLE_TABLE, DbTupleStore, RebacScopeForgetter, TupleCaveatConflict, TupleRecord, TupleStore, subjectKey } from '../../src/index.js';
import type { Tuple } from '../../src/index.js';
import { DIALECTS, bootDb, interceptDuring, rawQuery, statementsDuring } from '../support/db.js';
import type { Dialect, SpiedStatement, TestDb } from '../support/db.js';
import { d1, ref, tuple, user } from '../support/world.js';

const expect = chai.expect;

// MSSQL's limit, the lowest of the drivers SpinaJS ships.
const BIND_LIMIT = 2100;

/** The first word of each statement that names authz_rebac_tuple. */
const onTuples = (statements: readonly SpiedStatement[]): string[] => statements.filter((s) => s.sql.includes(AUTHZ_REBAC_TUPLE_TABLE)).map((s) => s.sql.trim().split(/\s+/)[0].toLowerCase());

const writes = /^\s*(insert|delete)\b/i;
const isTupleInsert = (sql: string): boolean => /^\s*insert\b/i.test(sql) && sql.includes(AUTHZ_REBAC_TUPLE_TABLE);
const isTupleDelete = (sql: string): boolean => /^\s*delete\b/i.test(sql) && sql.includes(AUTHZ_REBAC_TUPLE_TABLE);

/** True for the `nth` statement that `matches` answers true for, and for no other. */
function nthOf(matches: (sql: string) => boolean, nth: number): (sql: string) => boolean {
  let seen = 0;
  return (sql) => matches(sql) && ++seen === nth;
}

/** What `work` resolves to, or the error it rejects with. */
async function settled(work: () => Promise<unknown>): Promise<unknown> {
  try {
    return await work();
  } catch (e) {
    return e;
  }
}

const viewers = (object: string, prefix: string, n: number): Tuple[] => Array.from({ length: n }, (_, i) => tuple(ref('doc', object), 'viewer', user(`${prefix}${i}`)));

const ids = (tuples: readonly Tuple[]): string[] => tuples.map((t) => subjectKey(t.subject)).sort();

/** `word` once per batch of `size` among `n` rows. */
const batches = (word: string, n: number, size: number): string[] => Array.from({ length: Math.ceil(n / size) }, () => word);

async function rowsOn(db: TestDb, object: string): Promise<{ readonly total: number; readonly distinct: number }> {
  const [row] = (await rawQuery(db.driver, `SELECT COUNT(*) AS total, COUNT(DISTINCT subject_key) AS d FROM ${AUTHZ_REBAC_TUPLE_TABLE} WHERE object_id = ?`, [object])) as { total: number | string; d: number | string }[];
  return { total: Number(row.total), distinct: Number(row.d) };
}

/** Takes every write of the tuple table, as row history in full mode does, so the capture applies its row limit. */
class TupleCapture extends WriteObserver {
  public interest({ model }: WriteStatement): CaptureInterest | undefined {
    return model === TupleRecord ? { columns: '*', transactional: true } : undefined;
  }

  public observe(): Promise<void> {
    return Promise.resolve();
  }
}

/** Runs `work` with a root Configuration whose db.WriteCapture.MaxRows is `limit` (left unset for `undefined`). */
async function withMaxRows(limit: number | undefined, work: () => Promise<void>): Promise<void> {
  await testHost.installHost();
  try {
    if (limit !== undefined) testHost.config().set(['db', 'WriteCapture', 'MaxRows'], limit);
    await work();
  } finally {
    await testHost.uninstallHost();
  }
}

describe('authz-rebac: DbTupleStore batched writes (sqlite)', function () {
  this.timeout(120_000);
  let db: TestDb;

  before(async () => {
    db = await bootDb('tuple_batches');
  });

  after(async () => {
    await db?.dispose();
  });

  beforeEach(async () => {
    await rawQuery(db.driver, `DELETE FROM ${AUTHZ_REBAC_TUPLE_TABLE}`);
    await rawQuery(db.driver, `DELETE FROM ${CHANGE_LOG_TABLE}`);
  });

  it('writes the removals of a call in one DELETE and its additions in one INSERT, and nothing a capture or a trail would add', async () => {
    const store = new DbTupleStore();
    const viewer = (name: string) => tuple(d1, 'viewer', user(name));
    await store.write(['a', 'b', 'c'].map(viewer), [], user('admin'));
    const statements = await statementsDuring(db.driver, () => store.write(['d', 'e', 'f'].map(viewer), ['a', 'b', 'c'].map(viewer), user('admin')), /./);
    expect(onTuples(statements)).to.deep.equal(['select', 'delete', 'select', 'insert']);
    // P5 for ReBAC: without @spinajs/authz-replay/rebac no statement reads for a capture or writes a trail.
    expect(statements.filter((s) => /audit|history/i.test(s.sql))).to.deep.equal([]);
    expect(ids(await store.read(d1, 'viewer'))).to.deep.equal(['user:d', 'user:e', 'user:f']);
  });

  it('splits a large call into one DELETE per 500 stored tuples and one INSERT per 100 new ones, within the bind limit of every driver', async () => {
    const store = new DbTupleStore();
    const stored = viewers('d1', 's', 600);
    const fresh = viewers('d1', 'f', 250);
    await store.write(stored, [], user('admin'));
    let counts: unknown;
    const statements = await statementsDuring(
      db.driver,
      () =>
        db.driver.transaction(async (tx) => {
          counts = await store.writeIn({ driver: tx }, fresh, stored, user('admin'));
        }),
      /./,
    );
    expect(onTuples(statements)).to.deep.equal(['select', 'select', 'delete', 'delete', 'select', 'insert', 'insert', 'insert']);
    expect(counts).to.deep.equal({ added: fresh, removed: stored });
    expect(await rowsOn(db, 'd1')).to.deep.equal({ total: 250, distinct: 250 });
    const sizes = statements.filter((s) => isTupleInsert(s.sql) || isTupleDelete(s.sql)).map((s) => s.bindings.length);
    expect(Math.max(...sizes)).to.be.at.most(BIND_LIMIT);
    // 500 keys a DELETE; the INSERTs carry 100, 100 and 50 rows.
    expect(sizes.slice(0, 2)).to.deep.equal([500, 100]);
    expect(sizes.slice(2).map((n) => n / sizes[2])).to.deep.equal([1, 1, 0.5]);
  });

  it('loses and repeats no tuple at the batch boundaries, and runs no statement for an empty call', async () => {
    const store = new DbTupleStore();
    for (const n of [0, 99, 100, 101, 200, 201]) {
      const fresh = viewers(`a${n}`, 'f', n);
      let out: { readonly added: readonly Tuple[] } | undefined;
      const statements = await statementsDuring(db.driver, () => db.driver.transaction(async (tx) => void (out = await store.writeIn({ driver: tx }, fresh, [], user('admin')))), /./);
      expect(onTuples(statements).filter((w) => w === 'insert'), `${n} additions`).to.have.length(Math.ceil(n / 100));
      expect(out?.added, `${n} additions`).to.deep.equal(fresh);
      expect(await rowsOn(db, `a${n}`), `${n} additions`).to.deep.equal({ total: n, distinct: n });
      if (n === 0) expect(statements.filter((s) => /^\s*(savepoint|insert|delete|select)\b/i.test(s.sql))).to.deep.equal([]);
    }
    for (const n of [0, 499, 500, 501]) {
      const stored = viewers(`r${n}`, 's', n + 1);
      await store.write(stored, [], user('admin'));
      const removes = stored.slice(0, n);
      let out: { readonly removed: readonly Tuple[] } | undefined;
      const statements = await statementsDuring(db.driver, () => db.driver.transaction(async (tx) => void (out = await store.writeIn({ driver: tx }, [], removes, user('admin')))), writes);
      expect(onTuples(statements), `${n} removals`).to.deep.equal(batches('delete', n, 500));
      expect(out?.removed, `${n} removals`).to.deep.equal(removes);
      expect(ids(await store.read(ref('doc', `r${n}`), 'viewer')), `${n} removals`).to.deep.equal([subjectKey(user(`s${n}`))]);
    }
  });

  it('writes a tuple repeated in a call, or stored already, once, also when the copies fall into different batches', async () => {
    const store = new DbTupleStore();
    const stored = viewers('d1', 's', 5);
    await store.write(stored, [], user('admin'));
    const fresh = viewers('d1', 'f', 150);
    const adds = [stored[0], ...fresh.slice(0, 100), fresh[0], stored[4], fresh[99], ...fresh.slice(100), fresh[149], fresh[100]];
    let out: unknown;
    const inserts = await statementsDuring(db.driver, () => db.driver.transaction(async (tx) => void (out = await store.writeIn({ driver: tx }, adds, [], user('admin')))), writes);
    expect(onTuples(inserts)).to.deep.equal(['insert', 'insert']);
    expect(out).to.deep.equal({ added: fresh, removed: [] });

    const many = viewers('d1', 'g', 400);
    await store.write(many, [], user('admin'));
    // 555 tuples: the repeats of fresh[1] and many[0] come after the 500th, in the second batch.
    const removes = [...fresh, ...stored, fresh[0], stored[4], ...many, many[0], fresh[1]];
    const deletes = await statementsDuring(db.driver, () => db.driver.transaction(async (tx) => void (out = await store.writeIn({ driver: tx }, [], removes, user('admin')))), writes);
    expect(onTuples(deletes)).to.deep.equal(['delete', 'delete']);
    expect(out).to.deep.equal({ added: [], removed: [...fresh, ...stored, ...many] });
    expect(await rowsOn(db, 'd1')).to.deep.equal({ total: 0, distinct: 0 });
    // One change-log entry per tuple written, none for a repeat or a tuple stored already.
    const [log] = (await rawQuery(db.driver, `SELECT COUNT(*) AS n FROM ${CHANGE_LOG_TABLE}`)) as { n: number }[];
    expect(Number(log.n)).to.equal(5 + 150 + 400 + 555);
  });

  it('refuses a caveat conflict, among the additions of a call or with a stored tuple, before it inserts any of them', async () => {
    const store = new DbTupleStore();
    const alice = tuple(d1, 'viewer', user('alice'));
    const bob = tuple(d1, 'viewer', user('bob'));
    const carol = { ...tuple(d1, 'viewer', user('carol')), caveat: { name: 'a' } };
    await store.write([carol], [], user('admin'));
    for (const adds of [
      [alice, { ...bob, caveat: { name: 'a' } }, { ...bob, caveat: { name: 'b' } }],
      [alice, bob, { ...carol, caveat: { name: 'b' } }],
    ]) {
      let caught: unknown;
      // A caller that catches the conflict and lets its transaction commit.
      await db.driver.transaction(async (tx) => {
        try {
          await store.writeIn({ driver: tx }, adds, [], user('admin'));
        } catch (e) {
          caught = e;
        }
      });
      expect(caught).to.be.instanceOf(TupleCaveatConflict);
      expect(await store.read(d1, 'viewer')).to.deep.equal([carol]);
    }
  });

  it('write leaves nothing of a call when one of its later statements fails', async () => {
    const store = new DbTupleStore();
    const stored = viewers('d1', 's', 3);
    await store.write(stored, [], user('admin'));
    let error: unknown;
    await statementsDuring(
      db.driver,
      () =>
        store.write(viewers('d1', 'f', 150), stored, user('admin')).catch((e: unknown) => {
          error = e;
        }),
      /./,
      nthOf(isTupleInsert, 2),
    );
    expect(error).to.be.instanceOf(Error).with.property('message', 'refused by the test');
    expect(ids(await store.read(d1, 'viewer'))).to.deep.equal(['user:s0', 'user:s1', 'user:s2']);
  });

  it('writeIn leaves the statements of a failed call to the caller: a rollback undoes them all, a commit keeps those before the failure', async () => {
    const store = new DbTupleStore();
    const stored = viewers('d1', 's', 3);
    const fresh = viewers('d1', 'f', 150);
    for (const commit of [false, true]) {
      await store.write(stored, [], user('admin'));
      let error: unknown;
      await statementsDuring(
        db.driver,
        () =>
          db.driver
            .transaction(async (tx) => {
              try {
                await store.writeIn({ driver: tx }, fresh, stored, user('admin'));
              } catch (e) {
                error = e;
                if (!commit) throw e;
              }
            })
            .catch(() => undefined),
        /./,
        nthOf(isTupleInsert, 2),
      );
      expect(error, String(commit)).to.be.instanceOf(Error).with.property('message', 'refused by the test');
      expect(ids(await store.read(d1, 'viewer')), String(commit)).to.deep.equal(ids(commit ? fresh.slice(0, 100) : stored));
      await rawQuery(db.driver, `DELETE FROM ${AUTHZ_REBAC_TUPLE_TABLE}`);
    }
  });

  it('scope.forget over several batches returns one TupleChanged per removed tuple, and nothing when a batch fails', async () => {
    const store = new DbTupleStore();
    const container = DI.child();
    container.register(() => store).as(TupleStore);
    const ctx: AdminCallContext = { domain: 'test', now: new Date(), authz: { models: () => [] } as unknown as AuthzService, actor: SYSTEM, container, dryRun: false };
    const forget = () => db.driver.transaction((tx) => new RebacScopeForgetter().forget(d1, ctx, { driver: tx }));
    await store.write([...viewers('d1', 's', 1100), tuple(ref('doc', 'd2'), 'viewer', user('kept'))], [], user('admin'));
    const stored = (await store.find({ object: d1 })).items;

    let result: unknown;
    const deletes = await statementsDuring(db.driver, async () => void (result = await settled(forget)), writes, nthOf(isTupleDelete, 2));
    expect(onTuples(deletes)).to.deep.equal(['delete', 'delete']);
    // The error, and no result with events.
    expect(result).to.be.instanceOf(Error).with.property('message', 'refused by the test');
    expect(await rowsOn(db, 'd1')).to.deep.equal({ total: 1100, distinct: 1100 });

    const out = await forget();
    expect(out).to.deep.equal({ affected: 1100, tags: ['rebac', 'rebac:doc'], events: stored.map((t) => tupleChanged(ctx, t, 'delete')) });
    expect(await rowsOn(db, 'd1')).to.deep.equal({ total: 0, distinct: 0 });
    expect(ids(await store.read(ref('doc', 'd2'), 'viewer'))).to.deep.equal(['user:kept']);
  });

  it('keeps every statement within db.WriteCapture.MaxRows, so a call the capture took tuple by tuple is not refused', async () => {
    DI.register(TupleCapture).as(WriteObserver);
    DI.uncache(Array.ofType(WriteObserver));
    try {
      await withMaxRows(50, async () => {
        const store = new DbTupleStore();
        const stored = viewers('d1', 's', 120);
        await store.write(stored, [], user('admin'));
        const fresh = viewers('d1', 'f', 70);
        const statements = await statementsDuring(db.driver, () => store.write(fresh, stored, user('admin')), writes);
        expect(onTuples(statements)).to.deep.equal(['delete', 'delete', 'delete', 'insert', 'insert']);
        expect(await rowsOn(db, 'd1')).to.deep.equal({ total: 70, distinct: 70 });
      });
    } finally {
      DI.unregister(TupleCapture);
      DI.uncache(Array.ofType(WriteObserver));
    }
  });

  it('cuts batches to a db.WriteCapture.MaxRows of 1 and 3 with no loss or repeat at the boundaries', async () => {
    for (const limit of [1, 3]) {
      await withMaxRows(limit, async () => {
        const store = new DbTupleStore();
        for (const n of [...new Set([limit - 1, limit, limit + 1, 2 * limit + 1])]) {
          const object = `m${limit}_${n}`;
          const fresh = viewers(object, 'f', n);
          const added = await statementsDuring(db.driver, () => store.write(fresh, [], user('admin')), /^\s*(insert|savepoint)\b/i);
          expect(onTuples(added), `${n} additions of ${limit}`).to.deep.equal(batches('insert', n, limit));
          expect(added.filter((s) => /^\s*savepoint\b/i.test(s.sql)), `${n} additions of ${limit}`).to.have.length(Math.ceil(n / limit));
          expect(await rowsOn(db, object), `${n} additions of ${limit}`).to.deep.equal({ total: n, distinct: n });
          const removed = await statementsDuring(db.driver, () => store.write([], fresh, user('admin')), writes);
          expect(onTuples(removed), `${n} removals of ${limit}`).to.deep.equal(batches('delete', n, limit));
          expect(await rowsOn(db, object), `${n} removals of ${limit}`).to.deep.equal({ total: 0, distinct: 0 });
        }
      });
    }
  });

  it('keeps batches of 500 and 100 under a root Configuration whose db.WriteCapture.MaxRows is unset, 0 or above them', async () => {
    const store = new DbTupleStore();
    for (const [round, limit] of [
      ['unset', undefined],
      ['zero', 0],
      ['large', 100_000],
    ] as const) {
      await withMaxRows(limit, async () => {
        const stored = viewers(round, 's', 600);
        await store.write(stored, [], user('admin'));
        const fresh = viewers(round, 'f', 250);
        const statements = await statementsDuring(db.driver, () => store.write(fresh, stored, user('admin')), writes);
        expect(onTuples(statements), round).to.deep.equal(['delete', 'delete', 'insert', 'insert', 'insert']);
        expect(await rowsOn(db, round), round).to.deep.equal({ total: 250, distinct: 250 });
      });
    }
  });
});

/** Postgres and MySQL run the rival in a transaction of its own; SQLite has one connection, so there the rival joins the call's transaction. */
const OWN_CONNECTION: ReadonlySet<Dialect> = new Set(['postgres', 'mysql']);

for (const dialect of DIALECTS) {
  describe(`authz-rebac: DbTupleStore, a call of several batches (${dialect})`, function () {
    this.timeout(300_000);
    let db: TestDb;
    const store = new DbTupleStore();

    before(async function () {
      db = await bootDb('rp03b1_batches', this, dialect);
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      await rawQuery(db.driver, `DELETE FROM ${AUTHZ_REBAC_TUPLE_TABLE}`);
    });

    it('removes 600 stored tuples and adds 250 new ones in one call, each statement within the bind limit', async () => {
      const stored = viewers('d1', 's', 600);
      const fresh = viewers('d1', 'f', 250);
      await store.write(stored, [], user('admin'));
      let out: unknown;
      const statements = await statementsDuring(db.driver, () => db.driver.transaction(async (tx) => void (out = await store.writeIn({ driver: tx }, fresh, stored, user('admin')))), writes);
      expect(onTuples(statements)).to.deep.equal(['delete', 'delete', 'insert', 'insert', 'insert']);
      expect(Math.max(...statements.map((s) => s.bindings.length))).to.be.at.most(BIND_LIMIT);
      expect(out).to.deep.equal({ added: fresh, removed: stored });
      expect(await rowsOn(db, 'd1')).to.deep.equal({ total: 250, distinct: 250 });
    });

    /**
     * writeIn of `adds` with `rival` stored just before the call's second batch: on Postgres and MySQL in a committed
     * transaction of its own, before the batch's INSERT; SQLite runs one transaction at a time, so there the rival joins
     * it before the batch's savepoint.
     */
    async function raceInSecondBatch(rival: Tuple, adds: readonly Tuple[]): Promise<unknown> {
      const own = OWN_CONNECTION.has(dialect);
      const outside = AsyncResource.bind(() => store.write([rival], [], user('rival')));
      const second = nthOf(own ? isTupleInsert : (sql) => /^\s*savepoint\b/i.test(sql), 2);
      let fired = false;
      let out: unknown;
      await interceptDuring(
        db.driver,
        async () => void (out = await settled(() => db.driver.transaction((tx) => store.writeIn({ driver: tx }, adds, [], user('admin'))))),
        async (sql) => {
          if (fired || !second(sql)) return false;
          fired = true;
          await (own ? outside() : store.writeIn({ driver: db.driver }, [rival], [], user('rival')));
          return false;
        },
      );
      expect(fired, 'the rival wrote').to.equal(true);
      return out;
    }

    // PGlite is one connection that a second transaction waits for, and it shares Postgres' unique violation.
    if (dialect !== 'pglite') {
      it('a tuple another writer stored meanwhile in a later batch is skipped with the same caveat, the rest of the call goes in', async () => {
        const fresh = viewers('d1', 'f', 250);
        const rival = fresh[150];
        expect(await raceInSecondBatch(rival, fresh)).to.deep.equal({ added: fresh.filter((t) => t !== rival), removed: [] });
        expect(await rowsOn(db, 'd1')).to.deep.equal({ total: 250, distinct: 250 });
      });

      it('a tuple another writer stored meanwhile in a later batch with another caveat is a conflict', async () => {
        const fresh = viewers('d1', 'f', 250);
        const rival = { ...fresh[150], caveat: { name: 'a' } };
        expect(await raceInSecondBatch(rival, fresh)).to.be.instanceOf(TupleCaveatConflict);
        // On SQLite the rival wrote inside the transaction the conflict rolled back.
        expect(await store.read(d1, 'viewer')).to.deep.equal(OWN_CONNECTION.has(dialect) ? [rival] : []);
      });
    }
  });
}
