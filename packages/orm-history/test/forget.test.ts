import * as chai from 'chai';
import 'mocha';
import { audit, trailConfig } from '@spinajs/audit';
import { AuditTrailTableMigration, rowsOf } from '@spinajs/audit-orm';
import { historyOf, registerHistory } from '../src/index.js';
import { HistoryDb } from './support/db.js';
import type { Dialect, Place, TrackedClass } from './support/db.js';

const expect = chai.expect;

type Row = Record<string, unknown>;

class TrailTable extends AuditTrailTableMigration {
  constructor(private readonly name: string) {
    super();
  }

  protected override table(): string {
    return this.name;
  }
}

describe("forget erases a row on the model's connection and the trail's own", function () {
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
      const elsewhere: Dialect = dialect === 'sqlite' ? 'pglite' : 'sqlite';
      const trail = HistoryDb.trailOn(elsewhere);
      let table: TrailTable;
      let Invoice: TrackedClass;

      const rows = async (on: Place): Promise<Row[]> => rowsOf(await db.driver(on).select().from(trailConfig(trail).table).orderBy('seq'));
      const subjectRows = async (on: Place, id: string): Promise<Row[]> => (await rows(on)).filter((r) => r.subject_id === id && r.action !== 'erasure');
      const erasures = async (on: Place): Promise<unknown[]> => (await rows(on)).filter((r) => r.action === 'erasure').map((r) => [r.subject_id, JSON.parse(String(r.data)) as unknown]);
      // What another producer records about the subject: confirmed, so on the trail's own connection.
      const exported = (id: string): Promise<void> => audit().record({ kind: 'action', action: 'export', subject: { type: 'invoice', id }, data: { to: 'crm' } }, { trail, onFailure: 'reject' });

      const holders: readonly Place[] = [dialect, elsewhere, 'spare'];

      beforeEach(async () => {
        table = new TrailTable(trailConfig(trail).table);
        for (const on of holders) {
          await table.down(db.driver(on));
          await table.up(db.driver(on));
        }
        Invoice = await db.define({ name: 'Invoice', table: 'invoice', columns: { status: 'TEXT' }, decorate: (c) => registerHistory(c, { trail }) }, dialect);
        await Invoice.insert({ id: 'r1', status: 'a' });
        await Invoice.update({ status: 'b' }).where('id', 'r1');
        await Invoice.insert({ id: 'r2', status: 'a' });
        await exported('r1');
        await exported('r2');
      });

      afterEach(async () => {
        await db.clear();
        for (const on of holders) await table.down(db.driver(on));
      });

      const ways: readonly (readonly [string, () => Promise<number>])[] = [
        ['Model.history().forget(id)', () => Invoice.history().forget('r1')],
        ['row.history().forget()', async () => (await Invoice.get('r1')).history().forget()],
        ['historyOf(Model).forget(id)', () => historyOf(Invoice).forget('r1')],
      ];

      for (const [name, forget] of ways) {
        it(`${name} redacts the row's events on the model's connection and the subject's events on the trail's own`, async () => {
          expect(await forget()).to.eq(3);

          expect((await subjectRows(dialect, 'r1')).map((r) => [r.action, r.data])).to.deep.eq([
            ['insert', ''],
            ['update', ''],
          ]);
          expect((await subjectRows(elsewhere, 'r1')).map((r) => [r.action, r.data])).to.deep.eq([['export', '']]);
          expect((await subjectRows(dialect, 'r2')).map((r) => [r.action, r.data === ''])).to.deep.eq([['insert', false]]);
          expect((await subjectRows(elsewhere, 'r2')).map((r) => [r.action, r.data === ''])).to.deep.eq([['export', false]]);
          expect(await erasures(elsewhere)).to.deep.eq([['r1', { redacted: 1 }]]);
          expect(await erasures(dialect)).to.deep.eq([['r1', { redacted: 2 }]]);
        });
      }

      it("leaves the same subject alone on a connection that is neither the model's nor the trail's", async () => {
        const Legacy = await db.define({ name: 'LegacyInvoice', table: 'invoice', columns: { status: 'TEXT' }, decorate: (c) => registerHistory(c, { trail }) }, 'spare');
        await Legacy.insert({ id: 'r1', status: 'legacy' });

        expect(await Invoice.history().forget('r1')).to.eq(3);

        expect((await subjectRows('spare', 'r1')).map((r) => [r.action, r.data === ''])).to.deep.eq([['insert', false]]);
        expect(await erasures('spare')).to.deep.eq([]);
        expect((await Legacy.history().of('r1')).map((e) => [e.op, e.redacted, e.after])).to.deep.eq([['insert', false, { id: 'r1', status: 'legacy' }]]);

        expect(await audit().trail(trail).forget({ type: 'invoice', id: 'r1' })).to.eq(1);
        expect((await Legacy.history().of('r1')).map((e) => [e.op, e.redacted])).to.deep.eq([['insert', true]]);
        expect(await erasures('spare')).to.deep.eq([['r1', { redacted: 1 }]]);
      });

      it('answers redacted as of an instant after the erasure', async () => {
        await Invoice.history().forget('r1');
        const [, update] = await Invoice.history().of('r1');

        expect(await Invoice.history().asOf('r1', new Date(Date.now() + 1000))).to.deep.eq({ state: 'redacted', seq: update.seq });
        expect((await Invoice.history().asOf('r2', new Date(Date.now() + 1000))).state).to.eq('present');
      });
    });
  }
});
