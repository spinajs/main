import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { DI } from '@spinajs/di';
import { Hidden, Json, ReplicaRouter, SoftDelete } from '@spinajs/orm';

import { HistoryConfigError, registerHistory } from '../src/index.js';
import { HistoryDb, applyDecorator } from './support/db.js';
import type { ModelSpec, TrackedClass } from './support/db.js';
import { counted } from './support/statements.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const keys = (found: ReadonlyMap<string, unknown>): string[] => [...found.keys()].sort();
const padded = (i: number): string => `k${String(i).padStart(5, '0')}`;

describe('the current rows of a tracked model', function () {
  this.timeout(120000);
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
      const withNote = (name: string, decorate: ModelSpec['decorate']): Promise<TrackedClass> => db.define({ name, table: name.toLowerCase(), columns: { status: 'TEXT', note: 'TEXT' }, decorate }, dialect);

      beforeEach(async () => {
        await db.migrateHistory(dialect);
        Invoice = await db.define({ name: 'Invoice', table: 'invoice', columns: { status: 'TEXT' }, decorate: (c) => registerHistory(c) }, dialect);
      });

      afterEach(async () => {
        await db.clear();
      });

      it('reads each row as the after of its last entry, a date and a JSON column included', async () => {
        const Doc = await db.define(
          {
            name: 'Doc',
            table: 'doc',
            columns: { label: 'TEXT', body: 'JSON', at: 'DATETIME' },
            decorate: (c, p) => {
              registerHistory(c);
              applyDecorator(Json(), p, 'body');
            },
          },
          dialect,
        );
        await Doc.insert({ id: 'd1', label: 'Łukasz 東京', body: { b: [1, { d: 'ł', c: 2 }], a: null } });
        await Doc.update({ at: new Date(Date.UTC(2026, 10, 1, 12, 30, 15, 250)) }).where('id', 'd1');
        await Doc.insert({ id: 'd2', label: 'gone' });
        const lastImage = (await Doc.history().current(['d2'])).get('d2');
        await Doc.destroy('d2');

        const rows = await Doc.history().current(['d1', 'd2', 'none']);
        const last = await Doc.history().latest(['d1', 'd2']);
        expect(keys(rows)).to.deep.eq(['d1']);
        expect(rows.get('d1')).to.deep.eq(last.get('d1')?.after);
        expect(rows.get('d1')?.at).to.eq('2026-11-01T12:30:15.250Z');
        expect([last.get('d2')?.op, last.get('d2')?.after]).to.deep.eq(['delete', null]);
        expect(last.get('d2')?.before).to.deep.eq(lastImage);
      });

      it('leaves out what an entry leaves out: untracked, excluded and masked columns', async () => {
        const models = [
          await withNote('ByColumns', (c) => registerHistory(c, { columns: ['status'] })),
          await withNote('Excluded', (c) => registerHistory(c, { exclude: ['note'] })),
          await withNote('Masked', (c, p) => {
            applyDecorator(Hidden(), p, 'note');
            registerHistory(c);
          }),
        ];
        for (const model of models) {
          await model.insert({ id: 'a', status: 's', note: 'n' });
          await model.update({ status: 't' }).where('id', 'a');
          const image = (await model.history().current(['a'])).get('a');
          expect(image).to.deep.eq({ id: 'a', status: 't' });
          expect(image).to.deep.eq((await model.history().latest(['a'])).get('a')?.after);
        }
      });

      it('returns a soft-deleted row as its soft_delete entry holds it', async () => {
        const Note = await db.define(
          {
            name: 'Note',
            table: 'note',
            columns: { body: 'TEXT', deleted_at: 'TEXT' },
            decorate: (c, p) => {
              registerHistory(c);
              applyDecorator(SoftDelete(), p, 'deleted_at');
            },
          },
          dialect,
        );
        await Note.insert({ id: 'n1', body: 'a' });
        await Note.update({ deleted_at: '2026-11-06' }).where('id', 'n1');
        const last = (await Note.history().latest(['n1'])).get('n1');
        expect(last?.op).to.eq('soft_delete');
        expect((await Note.history().current(['n1'])).get('n1')).to.deep.eq(last?.after);
      });

      it('matches an integer key only by its own decimal text', async () => {
        const Counter = await db.define({ name: 'Counter', table: 'counter', columns: { v: 'TEXT' }, autoIncrement: true, decorate: (c) => registerHistory(c) }, dialect);
        await Counter.insert({ v: 'x' });
        const [entry] = await Counter.history().since(0);
        const id = entry.id;
        const read = await counted(db.driver(dialect), () => Counter.history().current([id, `0${id}`, `${id}.0`, ` ${id}`, `+${id}`, `${id}e0`, 'abc', '1.5']));
        expect(keys(read.result)).to.deep.eq([id]);
        expect(read.statements).to.eq(1);
        expect((await Counter.history().currentWhere({ id: 'abc' }, 10)).size).to.eq(0);
        expect(keys(await Counter.history().currentWhere({ id: entry.id }, 10))).to.deep.eq([id]);
      });

      it('matches a text key by its exact text: separators, wildcards, quotes and numbers as text', async () => {
        const ids = ['a,b', "a'b", 'a"b', 'a b', 'a;b', '%', '_', 'a\\b', 'Ł東', '1', '01'];
        await Invoice.insert([...ids, 'a', 'b', 'ab', 'A'].map((id) => ({ id, status: `of ${id}` })));
        const rows = await Invoice.history().current(ids);
        expect(keys(rows)).to.deep.eq([...ids].sort());
        for (const id of ids) expect(rows.get(id)).to.deep.eq({ id, status: `of ${id}` });
        expect(keys(await Invoice.history().current(['1.0', ' 1', 'a%', 'B']))).to.deep.eq([]);
      });

      it('reads 500 keys a statement, one for a key asked twice and none for no keys, and loses no key at a boundary', async () => {
        const boundaries = [0, 499, 500, 999, 1000, 32765, 32766, 32767, 65534, 65535, 65536];
        await Invoice.insert(boundaries.map((i) => ({ id: padded(i), status: String(i) })));
        for (const n of [499, 500, 501, 1001, 65537]) {
          const ids = Array.from({ length: n }, (_, i) => padded(i));
          const read = await counted(db.driver(dialect), () => Invoice.history().current(ids));
          expect(read.statements, `${n} keys`).to.eq(Math.ceil(n / 500));
          expect(keys(read.result), `${n} keys`).to.deep.eq(boundaries.filter((i) => i < n).map(padded));
        }
        const twice = await counted(db.driver(dialect), () => Invoice.history().current([padded(0), padded(0)]));
        expect([twice.result.size, twice.statements]).to.deep.eq([1, 1]);
        const none = await counted(db.driver(dialect), () => Invoice.history().current([]));
        expect([none.result.size, none.statements]).to.deep.eq([0, 0]);
      });

      it('selects rows by recorded columns, in key order, at most limit', async () => {
        await Invoice.insert([
          { id: 'c', status: 'open' },
          { id: 'a', status: 'open' },
          { id: 'b', status: 'paid' },
          { id: 'd', status: null },
        ]);
        const ids = async (where: Readonly<Record<string, unknown>>, limit = 10): Promise<string[]> => [...(await Invoice.history().currentWhere(where, limit)).keys()];
        expect(await ids({ status: 'open' })).to.deep.eq(['a', 'c']);
        expect(await ids({ status: 'open' }, 1)).to.deep.eq(['a']);
        expect(await ids({ status: null })).to.deep.eq(['d']);
        expect(await ids({ id: 'b', status: 'paid' })).to.deep.eq(['b']);
        expect(await ids({})).to.deep.eq(['a', 'b', 'c', 'd']);
        expect((await Invoice.history().currentWhere({ status: 'paid' }, 10)).get('b')).to.deep.eq({ id: 'b', status: 'paid' });
      });

      it('selects by the current state, not by any earlier image', async () => {
        await Invoice.insert([
          { id: 'was', status: 'open' },
          { id: 'now', status: 'paid' },
        ]);
        await Invoice.update({ status: 'paid' }).where('id', 'was');
        await Invoice.update({ status: 'open' }).where('id', 'now');
        expect([...(await Invoice.history().currentWhere({ status: 'open' }, 10))]).to.deep.eq([['now', { id: 'now', status: 'open' }]]);
      });

      it('refuses a column history does not record, a value it cannot compare and a bad limit', async () => {
        const Excluded = await withNote('Excluded', (c) => registerHistory(c, { exclude: ['note'] }));
        for (const column of ['note', 'nope']) {
          await expect(Excluded.history().currentWhere({ [column]: 'n' }, 1)).to.be.rejectedWith(HistoryConfigError, `orm-history: excluded does not record ${column}, so its history cannot tell which rows matched it`);
        }
        for (const value of [{ a: 1 }, true, Number.NaN]) {
          await expect(Excluded.history().currentWhere({ status: value }, 1)).to.be.rejectedWith(HistoryConfigError, 'orm-history: where.status must be a string, a finite number or null');
        }
        for (const limit of [0, 1.5]) await expect(Excluded.history().currentWhere({}, limit)).to.be.rejectedWith(HistoryConfigError, 'orm-history: limit must be an integer of 1 or more');
      });

      it('reads on the primary: the replica router is never asked', async () => {
        const router = DI.resolve(ReplicaRouter);
        const pick = router.pick.bind(router);
        let picks = 0;
        router.pick = (primary, query) => {
          picks += 1;
          return pick(primary, query);
        };
        try {
          await Invoice.insert({ id: 'a', status: 'open' });
          await Invoice.all();
          expect(picks, 'a model select asks the router').to.be.greaterThan(0);
          picks = 0;
          const history = Invoice.history();
          await history.latest(['a']);
          await history.latestBefore(['a'], new Date());
          await history.current(['a']);
          await history.currentWhere({ status: 'open' }, 1);
          expect(picks).to.eq(0);
        } finally {
          Reflect.deleteProperty(router, 'pick');
        }
      });
    });
  }

  describe('a key column that ignores case (sqlite)', () => {
    afterEach(async () => {
      await db.driver('sqlite').schema().dropTable('folded').ifExists();
      await db.clear();
    });

    it('answers only the ids asked, never a row the database matched in another spelling', async () => {
      await db.driver('sqlite')
        .schema()
        .createTable('folded', (t) => {
          t.text('id').primaryKey().collation('NOCASE');
          t.text('status');
        });
      const Folded = await db.define({ name: 'Folded', table: 'folded', columns: {}, existingTable: true, decorate: (c) => registerHistory(c) }, 'sqlite');
      await Folded.insert({ id: 'a', status: 'x' });
      expect(keys(await Folded.history().current(['A']))).to.deep.eq([]);
      expect(keys(await Folded.history().current(['A', 'a']))).to.deep.eq(['a']);
    });
  });

  describe('a text column that ignores case or trailing spaces, as on MySQL and MSSQL (sqlite)', () => {
    let Folded: TrackedClass;

    beforeEach(async () => {
      await db.driver('sqlite')
        .schema()
        .createTable('folded', (t) => {
          t.text('id').primaryKey();
          t.text('status').collation('NOCASE');
          t.text('code').collation('RTRIM');
        });
      Folded = await db.define({ name: 'Folded', table: 'folded', columns: {}, existingTable: true, decorate: (c) => registerHistory(c) }, 'sqlite');
    });

    afterEach(async () => {
      await db.driver('sqlite').schema().dropTable('folded').ifExists();
      await db.clear();
    });

    it('selects only the rows that hold each text as asked, reading on until limit rows or the end', async () => {
      await Folded.insert([
        { id: 'a', status: 'OPEN', code: 'x' },
        { id: 'b', status: 'open', code: 'x ' },
        { id: 'c', status: 'Open', code: 'x' },
        { id: 'd', status: 'open', code: 'x  ' },
      ]);
      const ids = async (where: Readonly<Record<string, unknown>>, limit: number): Promise<{ ids: string[]; statements: number }> => {
        const read = await counted(db.driver('sqlite'), () => Folded.history().currentWhere(where, limit));
        return { ids: [...read.result.keys()], statements: read.statements };
      };
      expect(await ids({ status: 'open' }, 1)).to.deep.eq({ ids: ['b'], statements: 2 });
      expect(await ids({ status: 'open' }, 2)).to.deep.eq({ ids: ['b', 'd'], statements: 2 });
      expect(await ids({ status: 'open' }, 10)).to.deep.eq({ ids: ['b', 'd'], statements: 1 });
      expect((await ids({ status: 'OPEN' }, 10)).ids).to.deep.eq(['a']);
      expect((await ids({ status: 'oPEN' }, 1)).ids).to.deep.eq([]);
      expect((await ids({ code: 'x ' }, 10)).ids).to.deep.eq(['b']);
      expect((await ids({ code: 'x', status: 'Open' }, 10)).ids).to.deep.eq(['c']);
      expect((await Folded.history().currentWhere({ status: 'open' }, 1)).get('b')).to.deep.eq({ id: 'b', status: 'open', code: 'x ' });
    });

    it('doubles each page past rows in another spelling, so that 201 of them take a few statements', async () => {
      await Folded.insert([...Array.from({ length: 200 }, (_, i) => ({ id: padded(i), status: 'BUSY' })), { id: padded(200), status: 'busy' }]);
      for (const [limit, most] of [
        [1, 8],
        [10, 5],
      ]) {
        const read = await counted(db.driver('sqlite'), () => Folded.history().currentWhere({ status: 'busy' }, limit));
        expect([...read.result.keys()]).to.deep.eq([padded(200)]);
        expect(read.statements, `limit ${limit}`).to.be.at.most(most);
      }
    });

    it('compares a number asked of a text column as the text the query bound', async () => {
      await Folded.insert([
        { id: 'a', code: '1 ' },
        { id: 'b', code: '1' },
      ]);
      expect([...(await Folded.history().currentWhere({ code: 1 }, 10)).keys()]).to.deep.eq(['b']);
    });
  });

  describe('a row whose key is NULL (sqlite)', () => {
    afterEach(async () => {
      await db.clear();
    });

    it('refuses the read: no id names the row', async () => {
      const Invoice = await db.define({ name: 'Invoice', table: 'invoice', columns: { status: 'TEXT' }, decorate: (c) => registerHistory(c) }, 'sqlite');
      await db.driver('sqlite').insert().into('invoice').values({ id: null, status: 'x' });
      await expect(Invoice.history().currentWhere({}, 5)).to.be.rejectedWith(HistoryConfigError, 'orm-history: a row of invoice has a primary key without a text (null), so no id names it');
    });
  });

  describe('a bigint key (pglite)', () => {
    afterEach(async () => {
      await db.clear();
    });

    it('finds the row by the decimal text of its key', async () => {
      await db.migrateHistory('pglite');
      const Big = await db.define({ name: 'Big', table: 'big', primary: ['id'], columns: { id: 'BIGINT', v: 'TEXT' }, decorate: (c) => registerHistory(c) }, 'pglite');
      await Big.insert({ id: 9007199254740993n, v: 'x' });
      const id = '9007199254740993';
      const image = (await Big.history().current([id])).get(id);
      expect(image).to.deep.eq({ id, v: 'x' });
      expect(image).to.deep.eq((await Big.history().latest([id])).get(id)?.after);
    });
  });
});
