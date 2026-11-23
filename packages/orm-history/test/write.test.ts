import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuditConfigError, AuditWriteFailed } from '@spinajs/audit';
import { MemoryAuditStore } from '@spinajs/audit/testing';
import { rowsOf } from '@spinajs/audit-orm';
import { Archived, Hidden, InsertQueryBuilder, SoftDelete, createQuery } from '@spinajs/orm';
import { HistoryConfigError, HistoryWriteError, LOST_SUBJECT_ID, registerHistory } from '../src/index.js';
import { who } from './support/audit.js';
import { HistoryDb, applyDecorator } from './support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

type Row = Record<string, unknown>;

const keyChange = (entity: string): string => `orm-history: an update of ${entity} writes its primary key id; history is keyed by it, delete and insert the row instead`;
const UNKNOWN_KEYS_REFUSED = 'orm-history: an insert of auto did not report the keys it wrote, so its history cannot be recorded; insert one row at a time or supply the keys';
const UNKNOWN_KEYS_WARNING = 'orm-history: an insert of auto did not report the keys it wrote, so its history is missing; insert one row at a time, supply the keys or set audit.data.onUnknownKeys to throw';

// rejectedWith(Class, text) matches a fragment; the messages above are asserted whole.
async function rejection(write: PromiseLike<unknown>): Promise<unknown> {
  try {
    await write;
  } catch (err) {
    return err;
  }
  throw new Error('expected the write to be refused');
}

describe('history writes', function () {
  this.timeout(60000);
  let db: HistoryDb;

  before(async () => {
    db = await HistoryDb.open();
  });

  after(async () => {
    await db?.close();
  });

  it('finds orm_history on the default connection, created by the migration the package ships', async () => {
    expect(await db.rows('orm_history', 'sqlite')).to.deep.eq([]);
  });

  for (const dialect of HistoryDb.dialects()) {
    describe(dialect, () => {
      let Invoice: Awaited<ReturnType<HistoryDb['define']>>;
      const events = async (): Promise<Row[]> => (await db.rows('orm_history', dialect)).map((r) => ({ ...r, data: JSON.parse(String(r.data)) as unknown }));

      beforeEach(async () => {
        await db.migrateHistory(dialect);
        Invoice = await db.define(
          {
            name: 'Invoice',
            table: 'invoice',
            columns: { status: 'TEXT', secret: 'TEXT', deleted_at: 'TEXT' },
            decorate: (c, p) => {
              registerHistory(c);
              applyDecorator(Hidden(), p, 'secret');
              applyDecorator(SoftDelete(), p, 'deleted_at');
            },
          },
          dialect,
        );
      });

      afterEach(async () => {
        await db.clear();
      });

      it('records insert, update and delete as data events with actor, impersonator and trace', async () => {
        who.actor = 'user:u1';
        who.onBehalfOf = 'user:admin';
        who.traceId = TRACE;
        await Invoice.insert({ id: 'i1', status: 'draft', secret: 's1' });
        await Invoice.update({ status: 'paid', secret: 's2' }).where('id', 'i1');
        await Invoice.destroy('i1');

        const rows = await events();
        // Invoice has @SoftDelete: ModelBase.destroy() updates deleted_at instead of deleting, recorded as soft_delete.
        expect(rows.map((r) => r.action)).to.deep.eq(['insert', 'update', 'soft_delete']);
        expect(rows.every((r) => r.kind === 'data' && r.outcome === 'ok' && r.subject_type === 'invoice' && r.subject_id === 'i1')).to.eq(true);
        expect(rows.every((r) => r.actor === 'user:u1' && r.on_behalf_of === 'user:admin' && r.trace_id === TRACE)).to.eq(true);
        expect(rows[1].data).to.deep.eq({ before: { status: 'draft' }, after: { id: 'i1', status: 'paid', deleted_at: null }, changed: ['secret', 'status'] });
        expect(JSON.stringify(rows)).to.not.contain('s1').and.not.contain('s2');
      });

      it('records a hard delete of a model without @SoftDelete', async () => {
        const Note = await db.define({ name: 'Note', table: 'note', columns: { body: 'TEXT' }, decorate: (c) => registerHistory(c) }, dialect);
        await Note.insert({ id: 'n1', body: 'x' });
        await Note.destroy('n1');

        const rows = (await events()).filter((r) => r.subject_type === 'note');
        expect(rows.map((r) => r.action)).to.deep.eq(['insert', 'delete']);
        expect(rows[1].data).to.deep.eq({ before: { id: 'n1', body: 'x' } });
        expect(rows[1].on_behalf_of).to.eq(null);
      });

      it('rolls the events back with the write', async () => {
        await expect(
          Invoice.transaction(async () => {
            await Invoice.insert({ id: 'i2', status: 'draft' });
            throw new Error('caller failed');
          }),
        ).to.be.rejectedWith('caller failed');
        expect(await events()).to.have.length(0);
      });

      it('fails the write when the trail table is missing', async () => {
        await db.dropHistory(dialect);
        const where = `in orm_history on connection "${db.connectionName(dialect)}"`;
        await expect(Invoice.insert({ id: 'i3', status: 'x' })).to.be.rejectedWith(AuditWriteFailed, `audit: recording 1 event(s) of trail "history" ${where} failed; is the table migrated there (AuditTrailTableMigration)?`);
        expect(await db.rows('invoice', dialect)).to.have.length(0);
      });

      it('fails the write when the model names a trail that does not exist', async () => {
        const Stray = await db.define({ name: 'Stray', table: 'stray', columns: { v: 'TEXT' }, decorate: (c) => registerHistory(c, { trail: 'no-such-trail' }) }, dialect);
        await expect(Stray.insert({ id: 's1', v: 'x' })).to.be.rejectedWith(AuditConfigError, 'audit: no trail named "no-such-trail"');
        expect(await db.rows('stray', dialect)).to.have.length(0);
      });

      it('records an update that names the primary key with its unchanged value', async () => {
        await Invoice.insert({ id: 'i4', status: 'x' });
        await Invoice.update({ id: 'i4', status: 'y' }).where('id', 'i4');
        expect((await events()).map((r) => [r.action, r.data])).to.deep.eq([
          ['insert', { after: { id: 'i4', status: 'x', deleted_at: null } }],
          ['update', { before: { status: 'x' }, after: { id: 'i4', status: 'y', deleted_at: null }, changed: ['status'] }],
        ]);
      });

      it('refuses an update that changes the primary key and leaves the row and its history as they were', async () => {
        await Invoice.insert({ id: 'i4', status: 'x' });
        expect(await rejection(Invoice.update({ id: 'i5' }).where('id', 'i4')))
          .to.be.instanceOf(HistoryWriteError)
          .and.have.property('message', keyChange('invoice'));
        expect((await db.rows('invoice', dialect)).map((r) => r.id)).to.deep.eq(['i4']);
        expect((await events()).map((r) => r.action)).to.deep.eq(['insert']);
      });

      it('records archive() of a tracked @Archived model as an update', async () => {
        const Doc = await db.define(
          {
            name: 'Doc',
            table: 'doc',
            columns: { status: 'TEXT', archived_at: 'TEXT' },
            decorate: (c, p) => {
              registerHistory(c);
              applyDecorator(Archived(), p, 'archived_at');
            },
          },
          dialect,
        );
        await Doc.insert({ id: 'd1', status: 'x' });
        await (await Doc.getOrFail('d1')).archive();

        const rows = (await events()).filter((r) => r.subject_type === 'doc');
        expect(rows.map((r) => r.action)).to.deep.eq(['insert', 'update']);
        expect(rows[1].data).to.deep.include({ before: { archived_at: null }, changed: ['archived_at'] });
      });

      it('records every row of a multi-row insert through RETURNING', async () => {
        const Auto = await db.define({ name: 'Auto', table: 'auto', autoIncrement: true, columns: { v: 'TEXT' }, decorate: (c) => registerHistory(c) }, dialect);
        await Auto.insert([{ v: 'a' }, { v: 'b' }]);
        const rows = (await events()).filter((r) => r.subject_type === 'auto');
        expect(rows.map((r) => [r.action, r.subject_id])).to.deep.eq([
          ['insert', '1'],
          ['insert', '2'],
        ]);
      });

      it('marks the entity lost when an insert does not report its keys', async () => {
        // A builder made without ModelBase.insert has no RETURNING.
        const Auto = await db.define({ name: 'Auto', table: 'auto', autoIncrement: true, columns: { v: 'TEXT' }, decorate: (c) => registerHistory(c) }, dialect);
        const { query } = createQuery(Auto, InsertQueryBuilder);
        await query.values([{ v: 'a' }, { v: 'b' }]);

        expect(await db.rows('auto', dialect)).to.have.length(2);
        const rows = (await events()).filter((r) => r.subject_type === 'auto');
        expect(rows.map((r) => [r.action, r.subject_id, r.data])).to.deep.eq([['lost', LOST_SUBJECT_ID, { reason: 'unknown_keys' }]]);
      });

      it('warns once per model about inserts that do not report their keys', async () => {
        const Auto = await db.define({ name: 'Auto', table: 'auto', autoIncrement: true, columns: { v: 'TEXT' }, decorate: (c) => registerHistory(c) }, dialect);
        await createQuery(Auto, InsertQueryBuilder).query.values([{ v: 'a' }, { v: 'b' }]);
        await createQuery(Auto, InsertQueryBuilder).query.values([{ v: 'c' }, { v: 'd' }]);

        expect((await events()).map((r) => r.action)).to.deep.eq(['lost', 'lost']);
        expect(db.warnings()).to.deep.eq([UNKNOWN_KEYS_WARNING]);
      });

      it('throws on unknown insert keys when configured to', async () => {
        db.config.set('audit.data.onUnknownKeys', 'throw');
        try {
          const Auto = await db.define({ name: 'Auto', table: 'auto', autoIncrement: true, columns: { v: 'TEXT' }, decorate: (c) => registerHistory(c) }, dialect);
          const { query } = createQuery(Auto, InsertQueryBuilder);
          expect(await rejection(query.values([{ v: 'a' }, { v: 'b' }])))
            .to.be.instanceOf(HistoryWriteError)
            .and.have.property('message', UNKNOWN_KEYS_REFUSED);
          expect(await db.rows('auto', dialect)).to.have.length(0);
        } finally {
          db.config.set('audit.data.onUnknownKeys', 'warn');
        }
      });

      it('names a soft delete and a restore', async () => {
        await Invoice.insert({ id: 'i6', status: 'x' });
        await Invoice.update({ deleted_at: '2026-11-06' }).where('id', 'i6');
        await Invoice.update({ deleted_at: null }).where('id', 'i6');
        expect((await events()).map((r) => r.action)).to.deep.eq(['insert', 'soft_delete', 'restore']);
      });

      it('records only the listed columns and skips an update that writes none of them', async () => {
        const Ticket = await db.define({ name: 'Ticket', table: 'ticket', columns: { status: 'TEXT', note: 'TEXT' }, decorate: (c) => registerHistory(c, { columns: ['status'] }) }, dialect);
        await Ticket.insert({ id: 't1', status: 'open', note: 'a' });
        await Ticket.update({ note: 'b' }).where('id', 't1');
        await Ticket.update({ status: 'closed', note: 'c' }).where('id', 't1');

        const rows = (await events()).filter((r) => r.subject_type === 'ticket');
        expect(rows.map((r) => [r.action, r.data])).to.deep.eq([
          ['insert', { after: { id: 't1', status: 'open' } }],
          ['update', { before: { status: 'open' }, after: { id: 't1', status: 'closed' }, changed: ['status'] }],
        ]);
      });

      it('in column mode records nothing for an unchanged key and refuses a changed one', async () => {
        const Ticket = await db.define({ name: 'Ticket', table: 'ticket', columns: { status: 'TEXT', note: 'TEXT' }, decorate: (c) => registerHistory(c, { columns: ['status'] }) }, dialect);
        await Ticket.insert({ id: 't1', status: 'open', note: 'a' });
        await Ticket.update({ id: 't1', note: 'b' }).where('id', 't1');
        await Ticket.update({ id: 't1', status: 'closed' }).where('id', 't1');
        expect(await rejection(Ticket.update({ id: 't9' }).where('id', 't1')))
          .to.be.instanceOf(HistoryWriteError)
          .and.have.property('message', keyChange('ticket'));

        expect((await db.rows('ticket', dialect)).map((r) => [r.id, r.status, r.note])).to.deep.eq([['t1', 'closed', 'b']]);
        expect((await events()).filter((r) => r.subject_type === 'ticket').map((r) => [r.action, r.data])).to.deep.eq([
          ['insert', { after: { id: 't1', status: 'open' } }],
          ['update', { before: { status: 'open' }, after: { id: 't1', status: 'closed' }, changed: ['status'] }],
        ]);
      });

      it('records a subclass of a tracked model under the table it shares with its base', async () => {
        const RushInvoice = await db.define({ name: 'RushInvoice', table: 'invoice', base: Invoice, columns: {}, decorate: () => undefined }, dialect);
        await RushInvoice.insert({ id: 'r1', status: 'draft', secret: 's1' });

        expect((await events()).map((r) => [r.action, r.subject_type, r.subject_id, r.data])).to.deep.eq([['insert', 'invoice', 'r1', { after: { id: 'r1', status: 'draft', deleted_at: null } }]]);
      });

      it("records the values of @Hidden columns with hidden: 'record'", async () => {
        const Secret = await db.define(
          {
            name: 'Secret',
            table: 'secret',
            columns: { token: 'TEXT' },
            decorate: (c, p) => {
              registerHistory(c, { hidden: 'record' });
              applyDecorator(Hidden(), p, 'token');
            },
          },
          dialect,
        );
        await Secret.insert({ id: 'k1', token: 't1' });
        await Secret.update({ token: 't2' }).where('id', 'k1');

        expect((await events()).map((r) => r.data)).to.deep.eq([{ after: { id: 'k1', token: 't1' } }, { before: { token: 't1' }, after: { id: 'k1', token: 't2' }, changed: ['token'] }]);
      });
    });
  }

  describe('trail and rules (sqlite)', () => {
    const rules = (value: unknown): void => db.config.set('audit.data.rules', value);

    beforeEach(async () => {
      await db.migrateHistory('sqlite');
    });

    afterEach(async () => {
      rules([]);
      await db.clear();
    });

    it('hands the events to the trail the model names, together with the driver of the write', async () => {
      const Kept = await db.define({ name: 'Kept', table: 'kept', columns: { v: 'TEXT' }, decorate: (c) => registerHistory(c, { trail: 'recorded' }) }, 'sqlite');
      await Kept.insert({ id: 'k1', v: 'x' });

      expect(await db.rows('orm_history', 'sqlite')).to.have.length(0);
      expect(MemoryAuditStore.appends()).to.have.length(1);
      const [write] = MemoryAuditStore.appends();
      expect(write.trail.name).to.eq('recorded');
      expect(write.transaction).to.eq(db.driver('sqlite'));
      expect(write.events.map((e) => [e.kind, e.action, e.subject, e.data])).to.deep.eq([['data', 'insert', { type: 'kept', id: 'k1' }, { after: { id: 'k1', v: 'x' } }]]);
    });

    it('fails the write when its record cannot be written, also on a trail that carries on', async () => {
      const Kept = await db.define({ name: 'Kept', table: 'kept', columns: { v: 'TEXT' }, decorate: (c) => registerHistory(c, { trail: 'recorded' }) }, 'sqlite');
      MemoryAuditStore.failNext(1);

      await expect(Kept.insert({ id: 'k2', v: 'x' })).to.be.rejectedWith(AuditWriteFailed, 'audit: trail "recorded" could not record 1 event(s) in the transaction of the audited write');
      expect(await db.rows('kept', 'sqlite')).to.have.length(0);
      // One try only: a second one would have found the store working again.
      expect(MemoryAuditStore.appends()).to.have.length(0);
    });

    it('tracks a model no decorator names when a rule matches it', async () => {
      rules([{ models: '*', trail: 'history' }]);
      const Plain = await db.define({ name: 'Plain', table: 'plain', columns: { v: 'TEXT' }, decorate: () => undefined }, 'sqlite');
      await Plain.insert({ id: 'p1', v: 'x' });
      expect((await db.rows('orm_history', 'sqlite')).map((r) => [r.action, r.subject_type, r.subject_id])).to.deep.eq([['insert', 'plain', 'p1']]);
    });

    it('follows a change of the rules for a model whose spec it already resolved', async () => {
      const Plain = await db.define({ name: 'Plain', table: 'plain', columns: { v: 'TEXT' }, decorate: () => undefined }, 'sqlite');
      rules([{ models: '*' }]);
      await Plain.insert({ id: 'p1', v: 'x' });
      rules([{ models: '*', trail: 'recorded' }]);
      await Plain.insert({ id: 'p2', v: 'x' });
      rules([]);
      await Plain.insert({ id: 'p3', v: 'x' });

      expect((await db.rows('orm_history', 'sqlite')).map((r) => r.subject_id)).to.deep.eq(['p1']);
      expect(MemoryAuditStore.appends().map((a) => a.events.map((e) => e.subject?.id))).to.deep.eq([['p2']]);
      expect(await db.rows('plain', 'sqlite')).to.have.length(3);
    });

    it('leaves a model with @History(false) untracked under a match-all rule', async () => {
      rules([{ models: '*' }]);
      const Quiet = await db.define({ name: 'Quiet', table: 'quiet', columns: { v: 'TEXT' }, decorate: (c) => registerHistory(c, false) }, 'sqlite');
      await Quiet.insert({ id: 'q1', v: 'x' });
      expect(await db.rows('orm_history', 'sqlite')).to.have.length(0);
    });

    it('prefers the trail of the decorator over the trail of a rule', async () => {
      rules([{ models: '*', trail: 'recorded' }]);
      const Own = await db.define({ name: 'Own', table: 'own', columns: { v: 'TEXT' }, decorate: (c) => registerHistory(c) }, 'sqlite');
      await Own.insert({ id: 'o1', v: 'x' });
      expect(await db.rows('orm_history', 'sqlite')).to.have.length(1);
      expect(MemoryAuditStore.appends()).to.have.length(0);
    });

    it('refuses the first write of a @History model with a composite primary key', async () => {
      const Pair = await db.define({ name: 'Pair', table: 'pair', primary: ['a', 'b'], columns: { a: 'TEXT', b: 'TEXT', v: 'TEXT' }, decorate: (c) => registerHistory(c) }, 'sqlite');
      await expect(Pair.insert({ a: '1', b: '2', v: 'x' })).to.be.rejectedWith(HistoryConfigError, '@History on Pair: needs a single-column primary key, it has 2');
    });

    it('writes a model with a composite primary key under a match-all rule without recording it', async () => {
      rules([{ models: '*' }]);
      const Pair = await db.define({ name: 'Pair', table: 'pair', primary: ['a', 'b'], columns: { a: 'TEXT', b: 'TEXT', v: 'TEXT' }, decorate: () => undefined }, 'sqlite');
      await Pair.insert({ a: '1', b: '2', v: 'x' });
      expect(rowsOf(await db.driver('sqlite').select().from('pair'))).to.have.length(1);
      expect(await db.rows('orm_history', 'sqlite')).to.have.length(0);
    });
  });
});
