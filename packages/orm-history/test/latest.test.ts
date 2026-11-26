import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { audit } from '@spinajs/audit';
import type { AuditInput } from '@spinajs/audit';
import { rowsOf } from '@spinajs/audit-orm';

import { HistoryConfigError, registerHistory } from '../src/index.js';
import type { HistoryEntry } from '../src/index.js';
import { HistoryDb } from './support/db.js';
import type { TrackedClass } from './support/db.js';
import { counted } from './support/statements.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
const T = (minute: number, ms = 0): Date => new Date(Date.UTC(2026, 9, 1, 12, minute, 0, ms));

const event = (type: string, id: string, action: string, at: Date, status = String(at.getUTCMinutes())): AuditInput => ({
  kind: 'data',
  action,
  subject: { type, id },
  data: action === 'lost' ? { reason: 'unknown_keys' } : action === 'delete' ? { before: { id, status } } : { after: { id, status } },
  at,
});
const summary = (found: ReadonlyMap<string, HistoryEntry>): unknown[] => [...found].map(([id, e]) => [id, e.op, e.at.getUTCMinutes()]);
const statusOf = (found: ReadonlyMap<string, HistoryEntry>, id: string): unknown => found.get(id)?.after?.status;

describe('the last entries of many rows', function () {
  this.timeout(60000);
  let db: HistoryDb;

  before(async () => {
    db = await HistoryDb.open();
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of HistoryDb.dialects()) {
    describe(dialect, () => {
      let Invoice: TrackedClass;
      const write = (inputs: readonly AuditInput[]): Promise<void> => db.driver(dialect).transaction((tx) => audit().record(inputs, { trail: 'history', mode: 'transactional', transaction: tx, onFailure: 'reject' }));

      beforeEach(async () => {
        await db.migrateHistory(dialect);
        Invoice = await db.define({ name: 'Invoice', table: 'invoice', columns: { status: 'TEXT' }, decorate: (c) => registerHistory(c) }, dialect);
      });

      afterEach(async () => {
        await db.clear();
      });

      it('answers the last entry of each id at or before an instant, and at all', async () => {
        await write([event('invoice', 'a', 'insert', T(10)), event('invoice', 'b', 'insert', T(15)), event('invoice', 'a', 'update', T(20)), event('invoice', 'a', 'delete', T(30)), event('invoice', 'c', 'insert', T(40))]);
        expect(summary(await Invoice.history().latestBefore(['a', 'b', 'c', 'none'], T(20)))).to.deep.eq([['a', 'update', 20], ['b', 'insert', 15]]);
        expect(summary(await Invoice.history().latestBefore(['a'], T(19)))).to.deep.eq([['a', 'insert', 10]]);
        expect(summary(await Invoice.history().latest(['c', 'a', 'c']))).to.deep.eq([['c', 'insert', 40], ['a', 'delete', 30]]);
      });

      it('includes an entry exactly at the instant and none a millisecond after it', async () => {
        await write([event('invoice', 'a', 'insert', T(20, -1), 'before'), event('invoice', 'a', 'update', T(20), 'at'), event('invoice', 'a', 'update', T(20, 1), 'after')]);
        const at = async (instant: Date): Promise<unknown> => statusOf(await Invoice.history().latestBefore(['a'], instant), 'a');
        expect(await at(T(20))).to.eq('at');
        expect(await at(T(20, -1))).to.eq('before');
        expect(await at(T(20, 1))).to.eq('after');
        expect((await Invoice.history().latestBefore(['a'], T(20, -2))).has('a')).to.eq(false);
      });

      it('takes the highest seq, not the latest instant: in one instant and when the clock went back', async () => {
        await write([event('invoice', 'a', 'insert', T(20), 'first'), event('invoice', 'a', 'update', T(20), 'second')]);
        await write([event('invoice', 'b', 'insert', T(30), 'stamped later'), event('invoice', 'b', 'update', T(10), 'recorded later')]);
        expect(statusOf(await Invoice.history().latestBefore(['a'], T(20)), 'a')).to.eq('second');
        expect(statusOf(await Invoice.history().latest(['a']), 'a')).to.eq('second');
        expect(statusOf(await Invoice.history().latest(['b']), 'b')).to.eq('recorded later');
        expect(statusOf(await Invoice.history().latestBefore(['b'], T(20)), 'b')).to.eq('recorded later');
      });

      it('answers every asked id: one with entries, one first changed after the instant, one never changed, a deleted one, one asked twice', async () => {
        await write([event('invoice', 'a', 'insert', T(10)), event('invoice', 'late', 'insert', T(40)), event('invoice', 'gone', 'insert', T(5), 'last'), event('invoice', 'gone', 'delete', T(6), 'last')]);
        const asked = ['a', 'late', 'none', 'gone', 'a'];
        const before = await Invoice.history().latestBefore(asked, T(20));
        expect(asked.map((id) => before.has(id))).to.deep.eq([true, false, false, true, true]);
        expect([...before.keys()]).to.deep.eq(['a', 'gone']);
        expect([before.get('gone')?.op, before.get('gone')?.before, before.get('gone')?.after]).to.deep.eq(['delete', { id: 'gone', status: 'last' }, null]);
        expect([...(await Invoice.history().latest(asked)).keys()]).to.deep.eq(['a', 'late', 'gone']);
      });

      it('reads the row entries of this entity only, a forgotten row as redacted', async () => {
        await write([event('invoice', 'a', 'insert', T(10)), event('invoice', '*', 'lost', T(11)), event('note', 'a', 'insert', T(12))]);
        await Invoice.insert({ id: 'r', status: 'x' });
        await Invoice.history().forget('r');
        const found = await Invoice.history().latest(['a', '*', 'r']);
        expect([...found].map(([id, e]) => [id, e.entity, e.op, e.redacted, e.after])).to.deep.eq([
          ['a', 'invoice', 'insert', false, { id: 'a', status: '10' }],
          ['r', 'invoice', 'insert', true, null],
        ]);
      });

      it('matches an id by its exact text: separators, wildcards, quotes and numbers as text', async () => {
        const ids = ['a,b', "a'b", 'a"b', 'a b', 'a;b', '%', '_', 'a\\b', 'Ł東', '1', '01', 'A'];
        await write([...ids, 'a', 'b'].map((id) => event('invoice', id, 'insert', T(10), `of ${id}`)));
        const found = await Invoice.history().latest(ids);
        expect([...found].map(([id, e]) => [id, e.id, e.after?.status])).to.deep.eq(ids.map((id) => [id, id, `of ${id}`]));
        expect([...(await Invoice.history().latest(['1.0', ' 1', 'a%', 'B'])).keys()]).to.deep.eq([]);
      });

      it('reads one statement per distinct id and none for no ids, and loses no id of a long list', async () => {
        const ids = Array.from({ length: 501 }, (_, i) => `k${String(i).padStart(4, '0')}`);
        const changed = ['k0000', 'k0499', 'k0500'];
        await write(changed.map((id) => event('invoice', id, 'insert', T(10), id)));
        const many = await counted(db.driver(dialect), () => Invoice.history().latestBefore([...ids, ...changed], T(10)));
        expect(many.statements).to.eq(ids.length);
        expect([...many.result.keys()].sort()).to.deep.eq(changed);
        expect(changed.map((id) => statusOf(many.result, id))).to.deep.eq(changed);

        const none = await counted(db.driver(dialect), () => Invoice.history().latest([]));
        expect([none.result.size, none.statements]).to.deep.eq([0, 0]);
      });

      it('refuses an invalid instant before it reads', async () => {
        await expect(Invoice.history().latestBefore(['a'], new Date('2026-13-01'))).to.be.rejectedWith(HistoryConfigError, 'orm-history: at must be a valid Date');
      });
    });
  }

  describe('a trail whose subject_id ignores trailing spaces, as on MySQL and MSSQL (sqlite)', () => {
    let Invoice: TrackedClass;
    const write = (inputs: readonly AuditInput[]): Promise<void> => db.driver('sqlite').transaction((tx) => audit().record(inputs, { trail: 'history', mode: 'transactional', transaction: tx, onFailure: 'reject' }));

    // MySQL's utf8mb4_bin and MSSQL's BIN2 are PAD SPACE; sqlite's RTRIM collation compares the same way.
    const padSpaceTrail = async (): Promise<void> => {
      const driver = db.driver('sqlite');
      const ddl = rowsOf(await driver.select().from('sqlite_master').where('tbl_name', 'orm_history').whereNotNull('sql').orderByDescending('type')).map((row) => String(row.sql));
      await driver.schema().dropTable('orm_history');
      for (const sql of ddl) await driver.schema().raw(sql.replace('`subject_id` TEXT,', '`subject_id` TEXT COLLATE RTRIM,'));
    };

    beforeEach(async () => {
      await padSpaceTrail();
      Invoice = await db.define({ name: 'Invoice', table: 'invoice', columns: { status: 'TEXT' }, decorate: (c) => registerHistory(c) }, 'sqlite');
    });

    afterEach(async () => {
      await db.clear();
    });

    it('answers each id with its own entry, never the entry of an id that differs by trailing spaces', async () => {
      await write([event('invoice', 'k', 'insert', T(10), 'k'), event('invoice', 'k ', 'insert', T(20), 'k '), event('invoice', 'm ', 'insert', T(10), 'm '), event('invoice', 'm', 'insert', T(20), 'm')]);
      expect((await Invoice.history().of('k')).map((e) => e.id), 'the trail collides').to.deep.eq(['k', 'k ']);
      const asked = ['k', 'k ', 'm', 'm ', 'n '];
      const own = [
        ['k', 'k', 'k'],
        ['k ', 'k ', 'k '],
        ['m', 'm', 'm'],
        ['m ', 'm ', 'm '],
      ];
      const triples = (found: ReadonlyMap<string, HistoryEntry>): unknown[] => [...found].map(([id, e]) => [id, e.id, e.after?.status]);
      expect(triples(await Invoice.history().latest(asked))).to.deep.eq(own);
      expect(triples(await Invoice.history().latestBefore(asked, T(20)))).to.deep.eq(own);
      expect(triples(await Invoice.history().latestBefore(['k', 'm '], T(15)))).to.deep.eq([['k', 'k', 'k'], ['m ', 'm ', 'm ']]);
    });

    it('reads one page past the other id, and refuses when a full page holds no entry of the asked one', async () => {
      await write([event('invoice', 'k', 'insert', T(10), 'own'), ...Array.from({ length: 999 }, () => event('invoice', 'k ', 'update', T(20), 'other'))]);
      expect(statusOf(await Invoice.history().latest(['k']), 'k')).to.eq('own');
      await write([event('invoice', 'k ', 'update', T(30), 'other')]);
      await expect(Invoice.history().latest(['k'])).to.be.rejectedWith(HistoryConfigError, `orm-history: the trail's subject_id comparison takes "k " for "k" of invoice, and the last 1000 entries it matches are not "k"'s; ask the other ids without "k": history cannot tell its last entry until the trail compares subject_id exactly, trailing spaces included`);
      expect(statusOf(await Invoice.history().latestBefore(['k'], T(10)), 'k')).to.eq('own');
    });

    it('answers an id no row can have as absent, without a read, among the ids it answers', async () => {
      const Counter = await db.define({ name: 'Counter', table: 'counter', columns: { status: 'TEXT' }, autoIncrement: true, decorate: (c) => registerHistory(c) }, 'sqlite');
      await write([event('counter', '2', 'insert', T(10)), ...Array.from({ length: 1000 }, () => event('counter', '1', 'update', T(20)))]);
      const ids = ['1 ', '2', '01', ' 1', '1'];
      for (const read of [() => Counter.history().latest(ids), () => Counter.history().latestBefore(ids, T(30))]) {
        const found = await counted(db.driver('sqlite'), read);
        expect([[...found.result.keys()], found.statements]).to.deep.eq([['2', '1'], 2]);
      }
    });
  });
});
