import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { SoftDelete } from '@spinajs/orm';
import { registerHistory } from '../src/index.js';
import { who } from './support/audit.js';
import { HistoryDb, applyDecorator } from './support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

describe('history queries', function () {
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
      let Invoice: Awaited<ReturnType<HistoryDb['define']>>;

      beforeEach(async () => {
        await db.migrateHistory(dialect);
        Invoice = await db.define({ name: 'Invoice', table: 'invoice', columns: { status: 'TEXT', total: 'TEXT' }, decorate: (c) => registerHistory(c) }, dialect);
      });

      afterEach(async () => {
        await db.clear();
      });

      it('keeps the entries that changed one of the named columns', async () => {
        await Invoice.insert({ id: 'r1', status: 'draft', total: '10' });
        await Invoice.update({ status: 'paid' }).where('id', 'r1');
        await Invoice.update({ total: '20' }).where('id', 'r1');
        await Invoice.update({ status: 'sent', total: '30' }).where('id', 'r1');

        const status = await Invoice.history().of('r1', { changed: ['status'] });
        expect(status.map((e) => [e.op, e.before?.status, e.after?.status])).to.deep.eq([
          ['update', 'draft', 'paid'],
          ['update', 'paid', 'sent'],
        ]);

        const either = await Invoice.history().of('r1', { changed: ['status', 'total'] });
        expect(either.map((e) => e.changed)).to.deep.eq([['status'], ['total'], ['status', 'total']]);

        expect(await Invoice.history().of('r1', { changed: [] })).to.deep.eq([]);
        expect(await Invoice.history().of('r1', { changed: ['no_such_column'] })).to.deep.eq([]);
      });

      it('counts the limit in matching entries and continues from a cursor', async () => {
        await Invoice.insert({ id: 'r1', status: 'a', total: '1' });
        await Invoice.update({ status: 'b' }).where('id', 'r1');
        await Invoice.update({ total: '2' }).where('id', 'r1');
        await Invoice.update({ status: 'c' }).where('id', 'r1');
        await Invoice.update({ status: 'd' }).where('id', 'r1');

        const first = await Invoice.history().of('r1', { changed: ['status'], limit: 2 });
        expect(first.map((e) => e.after?.status)).to.deep.eq(['b', 'c']);

        const rest = await Invoice.history().of('r1', { changed: ['status'], limit: 2, afterSeq: first.at(-1)?.seq ?? 0 });
        expect(rest.map((e) => e.after?.status)).to.deep.eq(['d']);
      });

      it('filters the feed of the model and the entries of a loaded row', async () => {
        await Invoice.insert({ id: 'r1', status: 'a', total: '1' });
        await Invoice.insert({ id: 'r2', status: 'a', total: '1' });
        await Invoice.update({ total: '2' }).where('id', 'r1');
        await Invoice.update({ status: 'b' }).where('id', 'r2');

        const feed = await Invoice.history().since(0, { changed: ['status'] });
        expect(feed.map((e) => `${e.op}:${e.id}`)).to.deep.eq(['update:r2']);

        const row = await Invoice.get('r2');
        const own = await row.history().entries({ changed: ['status'] });
        expect(own.map((e) => e.after?.status)).to.deep.eq(['b']);
      });

      it('lists what one actor changed on the model', async () => {
        const Order = await db.define({ name: 'Order', table: 'order_row', columns: { status: 'TEXT' }, decorate: (c) => registerHistory(c) }, dialect);
        who.actor = 'user:1';
        await Invoice.insert({ id: 'r1', status: 'a', total: '1' });
        who.actor = 'user:2';
        await Invoice.insert({ id: 'r2', status: 'a', total: '1' });
        await Invoice.update({ status: 'b' }).where('id', 'r1');
        await Order.insert({ id: 'o1', status: 'new' });

        const mine = await Invoice.history().byActor('user:2');
        expect(mine.map((e) => `${e.op}:${e.id}:${e.actor}`)).to.deep.eq(['insert:r2:user:2', 'update:r1:user:2']);

        const statusOnly = await Invoice.history().byActor('user:2', { changed: ['status'] });
        expect(statusOnly.map((e) => `${e.op}:${e.id}`)).to.deep.eq(['update:r1']);

        const inserts = await Invoice.history().byActor('user:2', { ops: ['insert'] });
        expect(inserts.map((e) => e.id)).to.deep.eq(['r2']);

        expect(await Invoice.history().byActor('user:3')).to.deep.eq([]);
      });

      it('lists a redacted entry without changed and never with it', async () => {
        await Invoice.insert({ id: 'r1', status: 'a', total: '1' });
        await Invoice.update({ status: 'b' }).where('id', 'r1');
        await Invoice.history().forget('r1');

        expect((await Invoice.history().of('r1')).map((e) => [e.op, e.redacted])).to.deep.eq([
          ['insert', true],
          ['update', true],
        ]);
        expect(await Invoice.history().of('r1', { changed: ['status'] })).to.deep.eq([]);
      });

      it('matches a soft delete and a restore on the soft-delete column', async () => {
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
        await Note.update({ deleted_at: null }).where('id', 'n1');
        await Note.update({ body: 'b' }).where('id', 'n1');

        const entries = await Note.history().of('n1', { changed: ['deleted_at'] });
        expect(entries.map((e) => [e.op, e.changed])).to.deep.eq([
          ['soft_delete', ['deleted_at']],
          ['restore', ['deleted_at']],
        ]);
      });

      it('refuses a limit outside 1 to 1000 on both', async () => {
        await expect(Invoice.history().byActor('user:1', { limit: 0 })).to.be.rejectedWith('orm-history: limit must be an integer from 1 to 1000');
        await expect(Invoice.history().of('r1', { changed: ['status'], limit: 1001 })).to.be.rejectedWith('orm-history: limit must be an integer from 1 to 1000');
      });
    });
  }

  it('reads past a page of entries that do not match', async () => {
    await db.migrateHistory('sqlite');
    const Invoice = await db.define({ name: 'Invoice', table: 'invoice', columns: { status: 'TEXT', total: 'TEXT' }, decorate: (c) => registerHistory(c) }, 'sqlite');
    try {
      await Invoice.insert({ id: 'r1', status: 'a', total: '0' });
      // 1,001 updates that do not touch status: more than one page of 1000 before the entry that does.
      for (let i = 1; i <= 1001; i++) await Invoice.update({ total: String(i) }).where('id', 'r1');
      await Invoice.update({ status: 'b' }).where('id', 'r1');

      const hits = await Invoice.history().of('r1', { changed: ['status'], limit: 5 });
      expect(hits.map((e) => e.after?.status)).to.deep.eq(['b']);
    } finally {
      await db.clear();
    }
  });

  it('ends on a filter that matches nothing over more than one page', async () => {
    await db.migrateHistory('sqlite');
    const Invoice = await db.define({ name: 'Invoice', table: 'invoice', columns: { status: 'TEXT', total: 'TEXT' }, decorate: (c) => registerHistory(c) }, 'sqlite');
    try {
      who.actor = 'user:9';
      await Invoice.insert({ id: 'r1', status: 'a', total: '0' });
      for (let i = 1; i <= 1001; i++) await Invoice.update({ total: String(i) }).where('id', 'r1');

      expect(await Invoice.history().of('r1', { changed: ['status'] })).to.deep.eq([]);
      expect(await Invoice.history().since(0, { changed: ['status'] })).to.deep.eq([]);
      expect(await Invoice.history().byActor('user:9', { changed: ['status'] })).to.deep.eq([]);

      // The first page holds the insert and 999 updates; the limit is reached one entry into the second.
      const totals = await Invoice.history().of('r1', { changed: ['total'], limit: 1000 });
      expect([totals.length, totals.at(-1)?.after?.total]).to.deep.eq([1000, '1000']);
      const feed = await Invoice.history().since(0, { changed: ['total'], limit: 1000 });
      expect([feed.length, feed.at(-1)?.after?.total]).to.deep.eq([1000, '1000']);
      const mine = await Invoice.history().byActor('user:9', { changed: ['total'], limit: 1000 });
      expect([mine.length, mine.at(-1)?.after?.total]).to.deep.eq([1000, '1000']);
    } finally {
      await db.clear();
    }
  });
});
