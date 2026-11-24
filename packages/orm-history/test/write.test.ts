import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuditConfigError, AuditWriteFailed } from '@spinajs/audit';
import { MemoryAuditStore } from '@spinajs/audit/testing';
import { rowsOf } from '@spinajs/audit-orm';
import { Archived, Column, DeleteQueryBuilder, Hidden, InsertBehaviour, InsertQueryBuilder, Json, JsonValueConverter, SoftDelete, Uuid, createQuery, extractDecoratorPropertyDescriptor } from '@spinajs/orm';
import type { IModelDescriptor } from '@spinajs/orm';
import { LOST_SUBJECT_ID, toHistoryValue } from '../src/encode.js';
import { HistoryConfigError, HistoryWriteError, registerHistory } from '../src/index.js';
import { historySpecOf } from '../src/registry.js';
import { who } from './support/audit.js';
import { HistoryDb, applyDecorator } from './support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

type Row = Record<string, unknown>;

class DocJsonConverter extends JsonValueConverter {}
const DocJson = (): unknown =>
  extractDecoratorPropertyDescriptor((model: IModelDescriptor, _: unknown, column: string) => {
    model.Converters.set(column, { Class: DocJsonConverter });
  });

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

      it('refuses a key change inside a caller transaction, which the rollback of that transaction undoes', async () => {
        await Invoice.insert({ id: 'i4', status: 'x' });
        const failed = await rejection(
          Invoice.transaction(async () => {
            await Invoice.update({ id: 'i5' }).where('id', 'i4');
          }),
        );
        expect(failed).to.be.instanceOf(HistoryWriteError).and.have.property('message', keyChange('invoice'));
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

      it('records archive() in column mode, which tracks the @Archived column as it tracks the soft-delete one', async () => {
        const Doc = await db.define(
          {
            name: 'Doc',
            table: 'doc',
            columns: { status: 'TEXT', archived_at: 'TEXT' },
            decorate: (c, p) => {
              registerHistory(c, { columns: ['status'] });
              applyDecorator(Archived(), p, 'archived_at');
            },
          },
          dialect,
        );
        await Doc.insert({ id: 'd1', status: 'x' });
        await (await Doc.getOrFail('d1')).archive();

        const rows = (await events()).filter((r) => r.subject_type === 'doc');
        expect(rows.map((r) => r.action)).to.deep.eq(['insert', 'update']);
        expect(rows[0].data).to.deep.eq({ after: { id: 'd1', status: 'x', archived_at: null } });
        expect(rows[1].data).to.deep.include({ before: { archived_at: null }, changed: ['archived_at'] });
      });

      it('records an upsert as the update of the row it changes and the insert of the row it adds', async () => {
        await Invoice.insert({ id: 'u1', status: 'draft' });
        const { query } = createQuery(Invoice, InsertQueryBuilder);
        await query
          .values([
            { id: 'u1', status: 'paid' },
            { id: 'u2', status: 'draft' },
          ])
          .onDuplicate('id')
          .update(['status']);
        expect((await events()).map((r) => [r.action, r.subject_id])).to.deep.eq([
          ['insert', 'u1'],
          ['update', 'u1'],
          ['insert', 'u2'],
        ]);
      });

      it('records nothing for an insert-or-ignore that leaves its row as it was', async () => {
        await Invoice.insert({ id: 'u3', status: 'draft' });
        await Invoice.insert({ id: 'u3', status: 'paid' }, InsertBehaviour.InsertOrIgnore);
        expect((await db.rows('invoice', dialect)).map((r) => r.status)).to.deep.eq(['draft']);
        expect((await events()).map((r) => r.action)).to.deep.eq(['insert']);
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

      describe('encoding', () => {
        let Doc: Awaited<ReturnType<HistoryDb['define']>>;
        const BODY = { b: [1, { d: 'ł', c: 2 }], a: null };

        beforeEach(async () => {
          Doc = await db.define(
            {
              name: 'Doc',
              table: 'doc',
              columns: { label: 'TEXT', big: 'TEXT', body: 'JSON', at: 'DATETIME', typed: 'TEXT', native: 'TEXT', sub: 'TEXT' },
              decorate: (c, p) => {
                registerHistory(c);
                applyDecorator(Json(), p, 'body');
                applyDecorator(Column({ family: 'json' }), p, 'typed');
                applyDecorator(Column({ nativeType: 'jsonb' }), p, 'native');
                applyDecorator(DocJson(), p, 'sub');
              },
            },
            dialect,
          );
        });

        it('keeps non-ASCII text, a 64 KB value and a JSON column as the driver reads them', async () => {
          // 64 KB in UTF-8.
          const big = 'ł'.repeat(32 * 1024);
          await Doc.insert({ id: 'd1', label: 'Łukasz 東京 😀', big, body: BODY });

          const [row] = await db.rows('doc', dialect);
          const [entry] = await Doc.history().of('d1');
          expect(entry.after).to.deep.eq(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, toHistoryValue(v)])));
          expect([entry.after?.label, entry.after?.big]).to.deep.eq(['Łukasz 東京 😀', big]);
        });

        it('writes a date as an ISO string and no entry for the same instant in another Date', async () => {
          await Doc.insert({ id: 'd2', label: 'x' });
          await Doc.update({ at: new Date(Date.UTC(2026, 10, 1, 12, 30, 15, 250)) }).where('id', 'd2');
          await Doc.update({ at: new Date('2026-11-01T12:30:15.250Z') }).where('id', 'd2');

          const entries = await Doc.history().of('d2');
          expect(entries.map((e) => e.op)).to.deep.eq(['insert', 'update']);
          // PGlite returns a Date, which history writes as ISO; the sqlite driver stores the ISO text itself.
          expect(entries[1].after?.at).to.eq('2026-11-01T12:30:15.250Z');
        });

        const changes = async (id: string): Promise<unknown[]> => (await Doc.history().of(id)).map((e) => [e.op, e.changed]);

        it('records no update for an @Json column written again with its keys in another order, and one when a value in it changed', async () => {
          await Doc.insert({ id: 'd3', body: BODY });
          await Doc.update({ body: { a: null, b: [1, { c: 2, d: 'ł' }] } }).where('id', 'd3');
          await Doc.update({ body: { a: null, b: [1, { c: 3, d: 'ł' }] } }).where('id', 'd3');
          expect(await changes('d3')).to.deep.eq([['insert', []], ['update', ['body']]]);
        });

        it('names only the other column when an @Json column changed only its key order, and stores the values as the driver reads them', async () => {
          await Doc.insert({ id: 'd4', label: 'x', body: { a: 1, b: 2 } });
          await Doc.update({ label: 'y', body: { b: 2, a: 1 } }).where('id', 'd4');

          const [, entry] = await Doc.history().of('d4');
          const [row] = await db.rows('doc', dialect);
          expect([entry.changed, entry.before]).to.deep.eq([['label'], { label: 'x' }]);
          expect(entry.after?.body).to.deep.eq(row.body);
        });

        it('compares JSON text in a plain text column as text', async () => {
          await Doc.insert({ id: 'd5', label: '{"a":1,"b":2}' });
          await Doc.update({ label: '{"b":2,"a":1}' }).where('id', 'd5');
          expect(await changes('d5')).to.deep.eq([['insert', []], ['update', ['label']]]);
        });

        it('compares by value the text of a column whose @Column family is json', async () => {
          await Doc.insert({ id: 'd6', typed: '{"a":1,"b":2}' });
          await Doc.update({ typed: '{ "b": 2, "a": 1 }' }).where('id', 'd6');
          expect(await changes('d6')).to.deep.eq([['insert', []]]);
        });

        it('declares JSON a column whose @Column nativeType is jsonb, and one a subclass of JsonValueConverter converts', async () => {
          expect(historySpecOf(Doc)?.json).to.deep.eq(new Set(['body', 'sub', 'typed', 'native']));

          await Doc.insert({ id: 'd8', native: '{"a":1,"b":2}' });
          await Doc.update({ native: '{ "b": 2, "a": 1 }' }).where('id', 'd8');
          await Doc.update({ native: '{"a":1,"b":3}' }).where('id', 'd8');
          expect(await changes('d8')).to.deep.eq([['insert', []], ['update', ['native']]]);
        });

        it("compares as text a declared JSON column whose text holds a number with more than 15 significant digits or outside the double's normal range", async () => {
          await Doc.insert({ id: 'd9', typed: '{"n":12345678901234567891}' });
          await Doc.update({ typed: '{"n":12345678901234567892}' }).where('id', 'd9');
          await Doc.update({ typed: '{"a":1e400}' }).where('id', 'd9');
          await Doc.update({ typed: '{"a":null}' }).where('id', 'd9');
          expect(await changes('d9')).to.deep.eq([['insert', []], ['update', ['typed']], ['update', ['typed']], ['update', ['typed']]]);
        });

        it('records nothing for a reordered declared JSON column that holds ordinary numbers', async () => {
          await Doc.insert({ id: 'd10', typed: '{"a":1.5,"b":-20,"c":1e3,"d":123456789012345}' });
          await Doc.update({ typed: '{"d":123456789012345,"c":1000,"b":-20,"a":1.50}' }).where('id', 'd10');
          expect(await changes('d10')).to.deep.eq([['insert', []]]);
        });

        it('compares as text, in linear time, a cut-off double-encoded JSON text in a declared JSON column', async () => {
          const whole = JSON.stringify(JSON.stringify(Object.fromEntries(Array.from({ length: 13000 }, (_, i) => [`k${i}`, `v${i}`]))));
          await Doc.insert({ id: 'd11', typed: whole });
          await Doc.update({ typed: whole.slice(0, -1) }).where('id', 'd11');
          expect(await changes('d11')).to.deep.eq([['insert', []], ['update', ['typed']]]);
        }).timeout(5000);

        it('compares text that is not JSON in a declared JSON column as text', async () => {
          await Doc.insert({ id: 'd7', typed: '{"a":' });
          await Doc.update({ typed: '{"a": ' }).where('id', 'd7');
          await Doc.update({ typed: '{"a": ' }).where('id', 'd7');
          expect(await changes('d7')).to.deep.eq([['insert', []], ['update', ['typed']]]);
        });
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

    it('leaves a model whose @Uuid() key is stored as bytes untracked under a match-all rule, with a warning', async () => {
      rules([{ models: '*' }]);
      const Device = await db.define({ name: 'Device', table: 'device', columns: { v: 'TEXT' }, decorate: (_, p) => applyDecorator(Uuid(), p, 'id') }, 'sqlite');
      await Device.insert({ v: 'x' });
      expect(await db.rows('device', 'sqlite')).to.have.length(1);
      expect(await db.rows('orm_history', 'sqlite')).to.have.length(0);
      expect(db.warnings()).to.deep.eq(['orm-history: Device matches audit.data.rules but its primary key id is stored as bytes by @Uuid(), so it is not tracked']);
    });

    describe('an insert of one row whose key the database fills and does not return', () => {
      // sqlite reports the rowid as LastInsertId, which is not this key.
      const define = () => db.define({ name: 'Filled', table: 'filled', filledKey: true, columns: { v: 'TEXT' }, decorate: (c) => registerHistory(c) }, 'sqlite');
      const insert = (model: Awaited<ReturnType<typeof define>>) => createQuery(model, InsertQueryBuilder).query.values({ v: 'a' });

      it('marks the entity lost for unknown keys', async () => {
        const Filled = await define();
        await insert(Filled);

        expect(await db.rows('filled', 'sqlite')).to.have.length(1);
        expect((await db.rows('orm_history', 'sqlite')).map((r) => [r.action, r.subject_id, JSON.parse(String(r.data)) as unknown])).to.deep.eq([['lost', LOST_SUBJECT_ID, { reason: 'unknown_keys' }]]);
        expect(db.warnings()).to.deep.eq([UNKNOWN_KEYS_WARNING.replace('auto', 'filled')]);
      });

      it('fails with onUnknownKeys: throw', async () => {
        db.config.set('audit.data.onUnknownKeys', 'throw');
        try {
          const Filled = await define();
          expect(await rejection(insert(Filled)))
            .to.be.instanceOf(HistoryWriteError)
            .and.have.property('message', UNKNOWN_KEYS_REFUSED.replace('auto', 'filled'));
          expect(await db.rows('filled', 'sqlite')).to.have.length(0);
        } finally {
          db.config.set('audit.data.onUnknownKeys', 'warn');
        }
      });
    });

    describe('a write whose key has no text', () => {
      // Above 2^53 a JS number is not a safe integer; sqlite stores this one exactly.
      const UNSAFE = 2 ** 53 + 2;
      const define = () => db.define({ name: 'Wide', table: 'wide', autoIncrement: true, columns: { v: 'TEXT' }, decorate: (c) => registerHistory(c) }, 'sqlite');
      const keyless = (statement: string, entity: string, outcome: string): string =>
        `orm-history: ${statement} of ${entity} reached a primary key id that has no text (bytes, a date or a number that is not a safe integer), so its history ${outcome}; history needs a string or integer key`;
      const MISSING = 'is missing';
      const REFUSED = 'cannot be recorded';

      it('marks the entity lost and warns once per model', async () => {
        const Wide = await define();
        await Wide.insert({ id: UNSAFE, v: 'a' });
        await Wide.insert({ id: UNSAFE + 2, v: 'b' });
        expect(await db.rows('wide', 'sqlite')).to.have.length(2);
        expect((await db.rows('orm_history', 'sqlite')).map((r) => [r.action, r.subject_id, JSON.parse(String(r.data)) as unknown])).to.deep.eq([
          ['lost', LOST_SUBJECT_ID, { reason: 'keys_without_text' }],
          ['lost', LOST_SUBJECT_ID, { reason: 'keys_without_text' }],
        ]);
        expect(db.warnings()).to.deep.eq([keyless('an insert', 'wide', MISSING)]);
      });

      it('marks the entity lost before the entries of the same insert, so a row it recorded is present as of its insert', async () => {
        const Wide = await define();
        await Wide.insert([
          { id: 1, v: 'a' },
          { id: UNSAFE, v: 'b' },
        ]);
        const [inserted] = await Wide.history().of(1);
        const at = await Wide.history().asOf(1, inserted.at);
        expect(at.state === 'present' && at.seq).to.eq(inserted.seq);
        expect((await db.rows('orm_history', 'sqlite')).map((r) => [r.action, r.subject_id])).to.deep.eq([
          ['lost', LOST_SUBJECT_ID],
          ['insert', '1'],
        ]);
      });

      it('fails with onUnknownKeys: throw', async () => {
        db.config.set('audit.data.onUnknownKeys', 'throw');
        try {
          const Wide = await define();
          expect(await rejection(Wide.insert({ id: UNSAFE, v: 'a' })))
            .to.be.instanceOf(HistoryWriteError)
            .and.have.property('message', keyless('an insert', 'wide', REFUSED));
          expect(await db.rows('wide', 'sqlite')).to.have.length(0);
        } finally {
          db.config.set('audit.data.onUnknownKeys', 'warn');
        }
      });

      describe('stored as bytes', () => {
        const one = Buffer.from([1]);
        const two = Buffer.from([2]);
        // A TEXT column of sqlite keeps a bound Buffer as bytes.
        const defineKeyed = async () => {
          const Keyed = await db.define({ name: 'Keyed', table: 'keyed', columns: { email: 'TEXT', v: 'TEXT' }, decorate: (c) => registerHistory(c) }, 'sqlite');
          await db.driver('sqlite').schema().raw('CREATE UNIQUE INDEX keyed_email ON keyed (email)');
          return Keyed;
        };
        // Written past the capture, so the setup records nothing and warns about nothing.
        const seed = async (rows: Row[]) => {
          for (const row of rows) await db.driver('sqlite').insert().into('keyed').values(row);
        };
        const history = async () => (await db.rows('orm_history', 'sqlite')).map((r) => [r.action, r.subject_id, JSON.parse(String(r.data)) as unknown]);
        const lost = ['lost', LOST_SUBJECT_ID, { reason: 'keys_without_text' }];
        const names = async () => (await db.rows('keyed', 'sqlite')).map((r) => r.v);

        it('marks the entity lost for an update and a delete, and warns once per model', async () => {
          const Keyed = await defineKeyed();
          await seed([
            { id: one, email: 'a', v: 'one' },
            { id: two, email: 'b', v: 'two' },
          ]);

          await Keyed.update({ v: 'x' }).where('email', 'a');
          await createQuery(Keyed, DeleteQueryBuilder).query.where('email', 'b');

          expect(await history()).to.deep.eq([lost, lost]);
          expect(await names()).to.deep.eq(['x']);
          expect(db.warnings()).to.deep.eq([keyless('an update', 'keyed', MISSING)]);
        });

        it('names a delete in its warning', async () => {
          const Keyed = await defineKeyed();
          await seed([{ id: one, email: 'a', v: 'one' }]);

          await createQuery(Keyed, DeleteQueryBuilder).query.where('email', 'a');

          expect(await history()).to.deep.eq([lost]);
          expect(db.warnings()).to.deep.eq([keyless('a delete', 'keyed', MISSING)]);
        });

        it('fails an update and a delete with onUnknownKeys: throw and leaves the row unchanged', async () => {
          const Keyed = await defineKeyed();
          await seed([{ id: one, email: 'a', v: 'one' }]);
          db.config.set('audit.data.onUnknownKeys', 'throw');
          try {
            expect(await rejection(Keyed.update({ v: 'x' }).where('email', 'a')))
              .to.be.instanceOf(HistoryWriteError)
              .and.have.property('message', keyless('an update', 'keyed', REFUSED));
            expect(await rejection(createQuery(Keyed, DeleteQueryBuilder).query.where('email', 'a')))
              .to.be.instanceOf(HistoryWriteError)
              .and.have.property('message', keyless('a delete', 'keyed', REFUSED));
          } finally {
            db.config.set('audit.data.onUnknownKeys', 'warn');
          }
          expect(await names()).to.deep.eq(['one']);
          expect(await history()).to.deep.eq([]);
        });

        it('marks the entity lost for an upsert that reaches the row through another unique column', async () => {
          const Keyed = await defineKeyed();
          await seed([{ id: one, email: 'a', v: 'one' }]);

          await createQuery(Keyed, InsertQueryBuilder)
            .query.values([
              { id: 'k', email: 'a', v: 'new' },
              { id: 'n', email: 'z', v: 'other' },
            ])
            .onDuplicate('email')
            .update(['v']);

          expect(await history()).to.deep.eq([lost, ['insert', 'n', { after: { id: 'n', email: 'z', v: 'other' } }]]);
          // sqlite orders bytes after text.
          expect(await names()).to.deep.eq(['other', 'new']);
          expect(db.warnings()).to.deep.eq([keyless('an insert', 'keyed', MISSING)]);
        });

        it('fails such an upsert with onUnknownKeys: throw', async () => {
          const Keyed = await defineKeyed();
          await seed([{ id: one, email: 'a', v: 'one' }]);
          db.config.set('audit.data.onUnknownKeys', 'throw');
          try {
            const upsert = createQuery(Keyed, InsertQueryBuilder).query.values({ id: 'k', email: 'a', v: 'new' }).onDuplicate('email').update(['v']);
            expect(await rejection(upsert))
              .to.be.instanceOf(HistoryWriteError)
              .and.have.property('message', keyless('an insert', 'keyed', REFUSED));
          } finally {
            db.config.set('audit.data.onUnknownKeys', 'warn');
          }
          expect(await names()).to.deep.eq(['one']);
        });

        it('leaves an upsert that supplies such a key to the unknown keys, with one marker', async () => {
          const Keyed = await defineKeyed();

          await createQuery(Keyed, InsertQueryBuilder).query.values({ id: one, email: 'a', v: 'one' }).orIgnore();

          expect(await history()).to.deep.eq([['lost', LOST_SUBJECT_ID, { reason: 'unknown_keys' }]]);
          expect(await names()).to.deep.eq(['one']);
        });

        it('marks the entity lost before the entry of the row with text that the same update reached, so that row is present as of it', async () => {
          const Keyed = await defineKeyed();
          await seed([
            { id: one, email: 'a', v: 'one' },
            { id: 'k', email: 'b', v: 'two' },
          ]);

          await Keyed.update({ v: 'x' }).whereIn('email', ['a', 'b']);

          expect((await history()).map(([action, id]) => [action, id])).to.deep.eq([
            ['lost', LOST_SUBJECT_ID],
            ['update', 'k'],
          ]);
          const [updated] = await Keyed.history().of('k');
          const at = await Keyed.history().asOf('k', updated.at);
          expect(at.state === 'present' && at.seq).to.eq(updated.seq);
        });

        it('records no marker for writes that reach only keys with text', async () => {
          const Keyed = await defineKeyed();
          await Keyed.insert({ id: 'k', email: 'a', v: 'one' });
          await Keyed.update({ v: 'x' }).where('id', 'k');
          await createQuery(Keyed, InsertQueryBuilder).query.values({ id: 'n', email: 'a', v: 'y' }).onDuplicate('email').update(['v']);
          await createQuery(Keyed, DeleteQueryBuilder).query.where('id', 'k');

          expect((await history()).map(([action, id]) => [action, id])).to.deep.eq([
            ['insert', 'k'],
            ['update', 'k'],
            ['update', 'k'],
            ['delete', 'k'],
          ]);
          expect(db.warnings()).to.deep.eq([]);
        });
      });
    });
  });
});
