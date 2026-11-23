import * as chai from 'chai';
import 'mocha';
import { audit, auditStore, trailConfig } from '@spinajs/audit';
import type { AuditInput } from '@spinajs/audit';
import { LOST_SUBJECT_ID } from '../src/encode.js';
import { registerHistory } from '../src/index.js';
import { HistoryDb } from './support/db.js';

const expect = chai.expect;
const T = (minute: number): Date => new Date(Date.UTC(2026, 9, 1, 12, minute));

describe('asOf', function () {
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
      let Plan: Awaited<ReturnType<HistoryDb['define']>>;

      const write = (inputs: readonly AuditInput[]): Promise<void> => db.driver(dialect).transaction((tx) => audit().record(inputs, { trail: 'history', mode: 'transactional', transaction: tx, onFailure: 'reject' }));
      const change = (entity: string, id: string, action: string, minute: number, data: Record<string, unknown>): AuditInput => ({ kind: 'data', action, subject: { type: entity, id }, data, at: T(minute) });

      beforeEach(async () => {
        await db.migrateHistory(dialect);
        Invoice = await db.define({ name: 'Invoice', table: 'invoice', columns: { status: 'TEXT' }, decorate: (c) => registerHistory(c) }, dialect);
        Plan = await db.define({ name: 'Plan', table: 'plan', columns: { status: 'TEXT', tier: 'TEXT' }, decorate: (c) => registerHistory(c, { columns: ['status', 'tier'] }) }, dialect);
      });

      afterEach(async () => {
        await db.clear();
      });

      it('is absent before the insert and present with the row of the last entry after it', async () => {
        await write([
          // An earlier entry of the entity: the trail covers T(5).
          change('invoice', 'other', 'insert', 1, { after: { id: 'other', status: 'draft' } }),
          change('invoice', 'a1', 'insert', 10, { after: { id: 'a1', status: 'draft' } }),
          change('invoice', 'a1', 'update', 20, { before: { status: 'draft' }, after: { id: 'a1', status: 'paid' }, changed: ['status'] }),
        ]);
        const [inserted, updated] = await Invoice.history().of('a1');

        expect(await Invoice.history().asOf('a1', T(5))).to.deep.eq({ state: 'absent', seq: null });
        expect(await Invoice.history().asOf('a1', T(15))).to.deep.eq({ state: 'present', row: { id: 'a1', status: 'draft' }, seq: inserted.seq });
        const later = await Invoice.history().asOf('a1', T(25));
        expect(later.state === 'present' && [later.row.status, later.seq]).to.deep.eq(['paid', updated.seq]);
        // The instant of an entry `of` returned includes that entry.
        expect(await Invoice.history().asOf('a1', updated.at)).to.deep.eq({ state: 'present', row: { id: 'a1', status: 'paid' }, seq: updated.seq });
      });

      it('is unknown before the oldest entry of the entity: tracking may have started later', async () => {
        await write([change('invoice', 'b1', 'insert', 20, { after: { id: 'b1', status: 'draft' } })]);

        expect(await Invoice.history().asOf('b1', T(10))).to.deep.eq({ state: 'unknown' });
        expect((await Invoice.history().asOf('b1', T(25))).state).to.eq('present');
      });

      it('is unknown before the retention horizon for a row deleted and inserted again', async () => {
        await write([
          change('invoice', 'b2', 'insert', 10, { after: { id: 'b2', status: 'first' } }),
          change('invoice', 'b2', 'delete', 20, { before: { id: 'b2', status: 'first' } }),
          change('invoice', 'b3', 'insert', 30, { after: { id: 'b3', status: 'draft' } }),
          change('invoice', 'b2', 'insert', 40, { after: { id: 'b2', status: 'second' } }),
        ]);
        const trail = trailConfig('history');
        const reader = await (await auditStore(trail)).reader(trail);
        if (!reader) throw new Error('the history trail has no reader');
        expect(await reader.prune(trail, T(25), db.connectionName(dialect))).to.eq(2);

        // b2 existed at T(15), but its insert and delete are gone.
        expect(await Invoice.history().asOf('b2', T(15))).to.deep.eq({ state: 'unknown' });
        expect(await Invoice.history().asOf('b2', T(35))).to.deep.eq({ state: 'absent', seq: null });
        expect((await Invoice.history().asOf('b2', T(45))).state).to.eq('present');
      });

      it('is absent after a delete, with the seq of the delete', async () => {
        await write([
          change('invoice', 'a2', 'insert', 10, { after: { id: 'a2', status: 'draft' } }),
          change('invoice', 'a2', 'delete', 20, { before: { id: 'a2', status: 'draft' } }),
        ]);
        const [, removed] = await Invoice.history().of('a2');
        expect(await Invoice.history().asOf('a2', T(25))).to.deep.eq({ state: 'absent', seq: removed.seq });
      });

      it('is unknown when the entry that would decide was pruned or never written', async () => {
        // The history of a3 starts with an update: its insert is not retained.
        await write([change('invoice', 'a3', 'update', 20, { before: { status: 'a' }, after: { id: 'a3', status: 'b' }, changed: ['status'] })]);

        expect(await Invoice.history().asOf('a3', T(15))).to.deep.eq({ state: 'unknown' });
        expect((await Invoice.history().asOf('a3', T(25))).state).to.eq('present');
        expect(await Invoice.history().asOf('never-written', T(25))).to.deep.eq({ state: 'unknown' });
      });

      it('answers from the last entry in column mode too, also when the insert is not retained', async () => {
        await write([
          change('plan', 'p1', 'insert', 10, { after: { id: 'p1', status: 'trial', tier: 'free' } }),
          change('plan', 'p1', 'update', 20, { before: { tier: 'free' }, after: { id: 'p1', status: 'trial', tier: 'pro' }, changed: ['tier'] }),
          change('plan', 'p1', 'update', 30, { before: { status: 'trial' }, after: { id: 'p1', status: 'active', tier: 'pro' }, changed: ['status'] }),
          // The history of p2 starts with an update: its insert was pruned.
          change('plan', 'p2', 'update', 20, { before: { tier: 'free' }, after: { id: 'p2', status: 'trial', tier: 'pro' }, changed: ['tier'] }),
        ]);

        const at25 = await Plan.history().asOf('p1', T(25));
        expect(at25.state === 'present' && at25.row).to.deep.eq({ id: 'p1', status: 'trial', tier: 'pro' });
        const at35 = await Plan.history().asOf('p1', T(35));
        expect(at35.state === 'present' && at35.row).to.deep.eq({ id: 'p1', status: 'active', tier: 'pro' });
        const p2 = await Plan.history().asOf('p2', T(25));
        expect(p2.state === 'present' && p2.row).to.deep.eq({ id: 'p2', status: 'trial', tier: 'pro' });
        expect(await Plan.history().asOf('p2', T(15))).to.deep.eq({ state: 'unknown' });
      });

      it('orders entries of one instant by seq', async () => {
        await write([
          change('invoice', 'a4', 'insert', 10, { after: { id: 'a4', status: 'a' } }),
          change('invoice', 'a4', 'update', 10, { before: { status: 'a' }, after: { id: 'a4', status: 'b' }, changed: ['status'] }),
        ]);
        const now = await Invoice.history().asOf('a4', T(10));
        expect(now.state === 'present' && now.row.status).to.eq('b');
      });

      it('is unknown after a lost marker until a later entry of the row decides again', async () => {
        await write([
          change('invoice', 'a5', 'insert', 10, { after: { id: 'a5', status: 'a' } }),
          change('invoice', LOST_SUBJECT_ID, 'lost', 20, { reason: 'unknown_keys' }),
        ]);
        expect((await Invoice.history().asOf('a5', T(15))).state).to.eq('present');
        expect(await Invoice.history().asOf('a5', T(25))).to.deep.eq({ state: 'unknown' });

        await write([change('invoice', 'a5', 'update', 30, { before: { status: 'a' }, after: { id: 'a5', status: 'b' }, changed: ['status'] })]);
        expect((await Invoice.history().asOf('a5', T(35))).state).to.eq('present');
      });

      it('includes a recorded entry at the instant the trail table gave back for it', async () => {
        await Invoice.insert({ id: 'a8', status: 'a' });
        const [entry] = await Invoice.history().of('a8');
        const at = await Invoice.history().asOf('a8', entry.at);
        expect(at.state === 'present' && at.seq).to.eq(entry.seq);
      });

      it('answers redacted for a forgotten row, and still absent for a forgotten row that was deleted', async () => {
        await write([
          change('invoice', 'a6', 'insert', 10, { after: { id: 'a6', status: 'a' } }),
          change('invoice', 'a7', 'insert', 10, { after: { id: 'a7', status: 'a' } }),
          change('invoice', 'a7', 'delete', 20, { before: { id: 'a7', status: 'a' } }),
        ]);
        await Invoice.history().forget('a6');
        await Invoice.history().forget('a7');
        const [a6] = await Invoice.history().of('a6');
        const [, removed] = await Invoice.history().of('a7');

        expect(await Invoice.history().asOf('a6', T(15))).to.deep.eq({ state: 'redacted', seq: a6.seq });
        expect(await Invoice.history().asOf('a7', T(25))).to.deep.eq({ state: 'absent', seq: removed.seq });
      });
    });
  }
});
