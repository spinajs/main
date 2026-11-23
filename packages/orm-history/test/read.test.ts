import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuditConfigError, AuditNotSupported, audit } from '@spinajs/audit';
import type { AuditInput } from '@spinajs/audit';
import { ModelBase, Primary } from '@spinajs/orm';
import { HistoryConfigError, historyOf, registerHistory, toHistoryEntry } from '../src/index.js';
import type { HistoryEntry } from '../src/index.js';
import { who } from './support/audit.js';
import { HistoryDb, applyDecorator } from './support/db.js';
import type { Dialect } from './support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const T = (minute: number): Date => new Date(Date.UTC(2026, 9, 1, 12, minute));

type Row = Record<string, unknown>;

const change = (id: string, action: string, minute: number): AuditInput => ({ kind: 'data', action, subject: { type: 'invoice', id }, data: { after: { id, status: String(minute) } }, at: T(minute) });

class Untracked extends ModelBase {}

describe('history reads', function () {
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
      let Invoice: Awaited<ReturnType<HistoryDb['define']>>;
      const write = (inputs: readonly AuditInput[]): Promise<void> => db.driver(dialect).transaction((tx) => audit().record(inputs, { trail: 'history', mode: 'transactional', transaction: tx, onFailure: 'reject' }));

      beforeEach(async () => {
        await db.migrateHistory(dialect);
        Invoice = await db.define({ name: 'Invoice', table: 'invoice', columns: { status: 'TEXT' }, decorate: (c) => registerHistory(c) }, dialect);
      });

      afterEach(async () => {
        await db.clear();
      });

      it('lists one row in seq order with filters and a cursor', async () => {
        await Invoice.insert({ id: 'r1', status: 'a' });
        await Invoice.update({ status: 'b' }).where('id', 'r1');
        await Invoice.update({ status: 'c' }).where('id', 'r1');
        await Invoice.insert({ id: 'r2', status: 'z' });

        const all = await Invoice.history().of('r1');
        expect(all.map((e) => [e.entity, e.id, e.op, e.after?.status])).to.deep.eq([['invoice', 'r1', 'insert', 'a'], ['invoice', 'r1', 'update', 'b'], ['invoice', 'r1', 'update', 'c']]);
        expect(all[1].before).to.deep.eq({ status: 'a' });
        expect(all[1].changed).to.deep.eq(['status']);
        const page = await Invoice.history().of('r1', { afterSeq: all[0].seq, limit: 1 });
        expect(page.map((e) => e.seq)).to.deep.eq([all[1].seq]);
        expect((await Invoice.history().of('r1', { ops: ['insert'] })).length).to.eq(1);
        expect(await Invoice.history().of('r1', { ops: [] })).to.deep.eq([]);
        expect((await Invoice.history().since(all[2].seq)).map((e) => e.id)).to.deep.eq(['r2']);
      });

      it('keeps the entries of another entity out of a model cursor', async () => {
        const Note = await db.define({ name: 'Note', table: 'note', columns: { body: 'TEXT' }, decorate: (c) => registerHistory(c) }, dialect);
        await Note.insert({ id: 'n1', body: 'x' });
        await Invoice.insert({ id: 'r5', status: 'a' });
        expect((await Invoice.history().since(0)).map((e) => [e.entity, e.id])).to.deep.eq([['invoice', 'r5']]);
      });

      it('carries actor, impersonator and trace, and the trail answers what a request changed', async () => {
        who.actor = 'user:u1';
        who.onBehalfOf = 'user:admin';
        who.traceId = TRACE;
        await Invoice.insert({ id: 'r3', status: 'a' });

        const [entry] = await Invoice.history().of('r3');
        expect([entry.actor, entry.onBehalfOf, entry.traceId, entry.redacted]).to.deep.eq(['user:u1', 'user:admin', TRACE, false]);
        const request = await audit().trail('history').byTrace(TRACE, { source: db.connectionName(dialect), kinds: ['data'] });
        expect(request.flatMap((event) => toHistoryEntry(event) ?? []).map((e) => [e.entity, e.id, e.op])).to.deep.eq([['invoice', 'r3', 'insert']]);
      });

      it('forgets a row: the entries stay, their payload is gone, and the erasure is recorded beside them', async () => {
        const erasures = async (on: Dialect): Promise<Row[]> => (await db.rows('orm_history', on)).filter((r) => r.action === 'erasure');
        await Invoice.insert({ id: 'r4', status: 'a' });
        await Invoice.update({ status: 'b' }).where('id', 'r4');
        await Invoice.insert({ id: 'r6', status: 'a' });

        // The erasure event is not one of the redacted events.
        expect(await Invoice.history().forget('r4')).to.eq(2);
        const left = await Invoice.history().of('r4');
        expect(left.map((e) => [e.op, e.redacted, e.before, e.after, e.changed])).to.deep.eq([['insert', true, null, null, []], ['update', true, null, null, []]]);
        expect((await Invoice.history().of('r6'))[0].redacted).to.eq(false);

        // On the model's connection, the source that was redacted; the trail's own connection is `default`, sqlite here.
        const recorded = await erasures(dialect);
        expect(recorded.map((r) => [r.kind, r.subject_type, r.subject_id, JSON.parse(String(r.data)) as unknown])).to.deep.eq([['custom', 'invoice', 'r4', { redacted: 2 }]]);
        if (dialect !== 'sqlite') expect(await erasures('sqlite')).to.deep.eq([]);
      });

      it('windows a row and the entity by time and by seq', async () => {
        await write([change('r7', 'insert', 10), change('r7', 'update', 20), change('r7', 'update', 30), change('r8', 'insert', 40)]);
        const all = await Invoice.history().of('r7');
        const minutes = (entries: readonly HistoryEntry[]): number[] => entries.map((e) => e.at.getUTCMinutes());

        expect(minutes(await Invoice.history().of('r7', { from: T(15) }))).to.deep.eq([20, 30]);
        expect(minutes(await Invoice.history().of('r7', { to: T(25) }))).to.deep.eq([10, 20]);
        expect(minutes(await Invoice.history().of('r7', { from: T(15), to: T(25) }))).to.deep.eq([20]);
        expect(minutes(await Invoice.history().since(0, { from: T(15), to: T(35) }))).to.deep.eq([20, 30]);
        // The higher of the cursor and afterSeq wins.
        expect((await Invoice.history().since(all[0].seq, { afterSeq: all[2].seq })).map((e) => e.id)).to.deep.eq(['r8']);
      });

      it('refuses an untracked model and a bad limit', async () => {
        expect(() => historyOf(Untracked)).to.throw(HistoryConfigError, 'orm-history: Untracked is not tracked (no @History and no audit.data.rules match)');
        for (const limit of [0, 1001, 1.5]) await expect(Invoice.history().of('r1', { limit })).to.be.rejectedWith(HistoryConfigError, 'orm-history: limit must be an integer from 1 to 1000');
      });

      it('refuses an invalid instant and a bad afterSeq', async () => {
        const invalid = new Date('2026-13-01');
        await expect(Invoice.history().asOf('r1', invalid)).to.be.rejectedWith(HistoryConfigError, 'orm-history: at must be a valid Date');
        await expect(Invoice.history().of('r1', { from: invalid })).to.be.rejectedWith(HistoryConfigError, 'orm-history: from must be a valid Date');
        await expect(Invoice.history().since(0, { to: invalid })).to.be.rejectedWith(HistoryConfigError, 'orm-history: to must be a valid Date');
        for (const afterSeq of [-1, 1.5, Number.NaN]) {
          await expect(Invoice.history().of('r1', { afterSeq })).to.be.rejectedWith(HistoryConfigError, 'orm-history: afterSeq must be an integer of 0 or more');
          await expect(Invoice.history().since(0, { afterSeq })).to.be.rejectedWith(HistoryConfigError, 'orm-history: afterSeq must be an integer of 0 or more');
          await expect(Invoice.history().since(afterSeq)).to.be.rejectedWith(HistoryConfigError, 'orm-history: seq must be an integer of 0 or more');
        }
      });
    });
  }

  describe('a model the ORM has not loaded', () => {
    it('rejects every read with the missing connection', async () => {
      class Unbooted extends ModelBase<Unbooted> {
        public Id: number;
      }
      applyDecorator(Primary(), Unbooted.prototype, 'Id');
      registerHistory(Unbooted);
      try {
        const message = 'orm-history: Unbooted has no ORM connection yet (is the ORM booted?)';
        const history = historyOf(Unbooted);
        await expect(history.of(1)).to.be.rejectedWith(HistoryConfigError, message);
        await expect(history.asOf(1, new Date())).to.be.rejectedWith(HistoryConfigError, message);
        await expect(history.since(0)).to.be.rejectedWith(HistoryConfigError, message);
        await expect(history.forget(1)).to.be.rejectedWith(HistoryConfigError, message);
      } finally {
        registerHistory(Unbooted, false);
      }
    });
  });

  describe('a bigint key (pglite)', () => {
    afterEach(async () => {
      await db.clear();
    });

    it('is the subject id as decimal text, and finds the row by the bigint', async () => {
      await db.migrateHistory('pglite');
      const Big = await db.define({ name: 'Big', table: 'big', primary: ['id'], columns: { id: 'BIGINT', v: 'TEXT' }, decorate: (c) => registerHistory(c) }, 'pglite');
      await Big.insert({ id: 9007199254740993n, v: 'x' });

      const entries = await Big.history().of(9007199254740993n);
      expect(entries.map((e) => [e.id, e.op, e.after?.id])).to.deep.eq([['9007199254740993', 'insert', '9007199254740993']]);
      expect(await Big.history().of('9007199254740993')).to.deep.eq(entries);
    });
  });

  describe('a trail of the log store (sqlite)', () => {
    afterEach(async () => {
      await db.clear();
    });

    it('refuses the tracked write, because the store cannot join its transaction, and rejects every read with the error of the trail', async () => {
      const Logged = await db.define({ name: 'Logged', table: 'logged', columns: { v: 'TEXT' }, decorate: (c) => registerHistory(c, { trail: 'logged' }) }, 'sqlite');
      await expect(Logged.insert({ id: 'l1', v: 'x' })).to.be.rejectedWith(AuditConfigError, 'audit: a transactional write to trail "logged" needs a store that joins the caller\'s transaction, and LogAuditStore does not');
      expect(await db.rows('logged', 'sqlite')).to.have.length(0);

      await expect(Logged.history().of('l1')).to.be.rejectedWith(AuditNotSupported, 'audit: trail "logged" (store LogAuditStore) cannot be read from this application (of)');
      await expect(Logged.history().since(0)).to.be.rejectedWith(AuditNotSupported, 'cannot be read from this application (since)');
      // asOf reads through the trail's `of`.
      await expect(Logged.history().asOf('l1', new Date())).to.be.rejectedWith(AuditNotSupported, 'audit: trail "logged" (store LogAuditStore) cannot be read from this application (of)');
      await expect(Logged.history().forget('l1')).to.be.rejectedWith(AuditNotSupported, 'cannot be read from this application (forget)');
    });
  });
});
