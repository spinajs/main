import * as chai from 'chai';
import 'mocha';
import { audit } from '@spinajs/audit';
import type { AuditInput } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import { InsertQueryBuilder, Orm, createQuery } from '@spinajs/orm';

import { TableHistoryCoverage } from '../src/coverage.js';
import { HISTORY_COVERAGE_TABLE } from '../src/coverage-table.js';
import { LOST_SUBJECT_ID } from '../src/encode.js';
import { HistoryCoverage, registerHistory } from '../src/index.js';
import type { HistoryOptions } from '../src/index.js';
import { HistoryDb } from './support/db.js';

const expect = chai.expect;
const T = (minute: number): Date => new Date(Date.UTC(2026, 9, 1, 12, minute));
const noTable = (connection: string): string => `orm-history: ${connection} has no history_coverage table, so the history of its tracked models has no coverage; run the migration OrmHistoryCoverage_2026_11_25_00_00_00 there`;
const halfTracked = (table: string, connection: string): string => `orm-history: table ${table} on ${connection} is written by models that are not all tracked in one trail under one entity, so its history has no coverage; track every model of the table the same way`;

function tableCoverage(): TableHistoryCoverage {
  const coverage = DI.resolve(HistoryCoverage);
  if (!(coverage instanceof TableHistoryCoverage)) throw new Error('HistoryCoverage is not the table implementation');
  return coverage;
}

describe('history coverage', function () {
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
      let coverage: TableHistoryCoverage;
      const connection = (): string => db.connectionName(dialect);
      const since = (entity: string): Promise<Date | undefined> => coverage.since('history', connection(), entity);
      const stored = async (): Promise<unknown[]> => (await db.rows(HISTORY_COVERAGE_TABLE, dialect)).map((r) => [r.entity, JSON.parse(String(r.columns)) as unknown]);
      const invoice = () => db.define({ name: 'Invoice', table: 'invoice', columns: { status: 'TEXT' }, decorate: (c) => registerHistory(c) }, dialect);
      const plan = (options: HistoryOptions) => db.define({ name: 'Plan', table: 'plan', columns: { status: 'TEXT', tier: 'TEXT' }, decorate: (c) => registerHistory(c, options) }, dialect);
      const lost = (entity: string, minute: number): AuditInput => ({ kind: 'data', action: 'lost', subject: { type: entity, id: LOST_SUBJECT_ID }, data: { reason: 'unknown_keys' }, at: T(minute) });
      const write = (inputs: readonly AuditInput[]): Promise<void> => db.driver(dialect).transaction((tx) => audit().record(inputs, { trail: 'history', mode: 'transactional', transaction: tx, onFailure: 'reject' }));

      beforeEach(async () => {
        await db.migrateHistory(dialect);
        await db.migrateCoverage(dialect);
        coverage = tableCoverage();
      });

      afterEach(async () => {
        await db.clear();
        if (dialect !== 'sqlite') await db.dropCoverage(dialect);
      });

      it('is undefined for an entity nobody recorded', async () => {
        await invoice();
        expect(await since('invoice')).to.eq(undefined);
      });

      it('starts at the first pass that tracked the entity and keeps that instant on later passes', async () => {
        await invoice();
        await db.define({ name: 'Note', table: 'note', columns: { body: 'TEXT' }, decorate: () => undefined }, dialect);
        await coverage.record(undefined, T(1));
        await coverage.record(undefined, T(2));

        expect(await since('invoice')).to.deep.eq(T(1));
        expect(await since('note')).to.eq(undefined);
        expect(await stored()).to.deep.eq([['invoice', { recorded: ['id', 'status'], skipped: [] }]]);
      });

      it('records only the tables of the models it is given', async () => {
        const Invoice = await invoice();
        const Plan = await plan({});
        await coverage.record([Invoice], T(1));
        expect([await since('invoice'), await since('plan')]).to.deep.eq([T(1), undefined]);
        await coverage.record([Plan], T(2));
        expect([await since('invoice'), await since('plan')]).to.deep.eq([T(1), T(2)]);
      });

      it('takes an alias of the connection', async () => {
        await invoice();
        await coverage.record(undefined, T(1));
        expect(await coverage.since('history', HistoryDb.aliasOf(dialect), 'invoice')).to.deep.eq(T(1));
      });

      it('refuses a connection the ORM does not have', async () => {
        const refused: unknown = await coverage.since('history', 'nowhere', 'invoice').then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(refused).to.be.instanceOf(Error);
        expect(refused instanceof Error && refused.message).to.eq('orm-history: no ORM connection "nowhere" to read the coverage of invoice from');
      });

      it('starts again at a lost marker that is later than the row, and not at an earlier one', async () => {
        await invoice();
        await plan({});
        await coverage.record(undefined, T(10));
        await write([lost('invoice', 20), lost('plan', 5)]);

        expect(await since('invoice')).to.deep.eq(T(20));
        expect(await since('plan')).to.deep.eq(T(10));
      });

      it('ignores a lost marker whose write rolled back', async () => {
        await invoice();
        await coverage.record(undefined, T(10));
        const failed: unknown = await db
          .driver(dialect)
          .transaction(async (tx) => {
            await audit().record([lost('invoice', 20)], { trail: 'history', mode: 'transactional', transaction: tx, onFailure: 'reject' });
            throw new Error('caller failed');
          })
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(failed).to.be.instanceOf(Error);
        expect(await since('invoice')).to.deep.eq(T(10));
      });

      it('starts again when an insert does not report its keys', async () => {
        const Auto = await db.define({ name: 'Auto', table: 'auto', autoIncrement: true, columns: { v: 'TEXT' }, decorate: (c) => registerHistory(c) }, dialect);
        await coverage.record(undefined, T(1));
        const before = Date.now();
        // A builder made without ModelBase.insert has no RETURNING.
        await createQuery(Auto, InsertQueryBuilder).query.values([{ v: 'a' }, { v: 'b' }]);

        expect((await since('auto'))?.getTime()).to.be.at.least(before);
      });

      it('starts again when the registration records a column it left out before, and never moves back', async () => {
        const Plan = await plan({ exclude: ['tier'] });
        await coverage.record(undefined, T(1));
        expect(await stored()).to.deep.eq([['plan', { recorded: ['id', 'status'], skipped: ['tier'] }]]);

        registerHistory(Plan, {});
        await coverage.record(undefined, T(5));
        expect(await since('plan')).to.deep.eq(T(5));
        expect(await stored()).to.deep.eq([['plan', { recorded: ['id', 'status', 'tier'], skipped: [] }]]);

        registerHistory(Plan, { exclude: ['tier'] });
        await coverage.record(undefined, T(6));
        registerHistory(Plan, {});
        await coverage.record(undefined, T(2));
        expect(await since('plan')).to.deep.eq(T(5));
      });

      it('keeps its instant when the table gains a column or the registration leaves one out', async () => {
        const Plan = await plan({});
        await coverage.record(undefined, T(1));
        await db
          .driver(dialect)
          .schema()
          .alterTable('plan', (table) => {
            table.text('note');
          });
        await DI.get(Orm)?.reloadTableInfo();
        await coverage.record(undefined, T(2));
        expect(await since('plan')).to.deep.eq(T(1));
        expect(await stored()).to.deep.eq([['plan', { recorded: ['id', 'note', 'status', 'tier'], skipped: [] }]]);

        registerHistory(Plan, { exclude: ['tier'] });
        await coverage.record(undefined, T(3));
        expect(await since('plan')).to.deep.eq(T(1));
        expect(await stored()).to.deep.eq([['plan', { recorded: ['id', 'note', 'status'], skipped: ['tier'] }]]);
      });

      it('records the key and the tracked columns of a model in column mode', async () => {
        await plan({ columns: ['tier'] });
        await coverage.record(undefined, T(1));
        expect(await stored()).to.deep.eq([['plan', { recorded: ['id', 'tier'], skipped: ['status'] }]]);
      });

      it('claims nothing for a table another model writes untracked, and ends the earlier claim', async () => {
        await invoice();
        await coverage.record(undefined, T(1));
        expect(await since('invoice')).to.deep.eq(T(1));

        await db.define({ name: 'Shadow', table: 'invoice', existingTable: true, columns: {}, decorate: () => undefined }, dialect);
        await coverage.record(undefined, T(2));
        await coverage.record(undefined, T(3));
        expect(await since('invoice')).to.eq(undefined);
        expect(db.warnings()).to.deep.eq([halfTracked('invoice', connection())]);
      });

      it('ends the coverage of a model that opts out', async () => {
        const Invoice = await invoice();
        await plan({});
        await coverage.record(undefined, T(1));
        registerHistory(Invoice, false);
        await coverage.record(undefined, T(2));

        expect([await since('invoice'), await since('plan')]).to.deep.eq([undefined, T(1)]);
      });

      it('records the other tables when one model cannot be tracked', async () => {
        await invoice();
        await db.define({ name: 'Pair', table: 'pair', primary: ['a', 'b'], columns: { a: 'TEXT', b: 'TEXT' }, decorate: (c) => registerHistory(c) }, dialect);
        await coverage.record(undefined, T(1));

        expect(await since('invoice')).to.deep.eq(T(1));
        expect(db.warnings().filter((w) => w.startsWith(`orm-history: the coverage of table pair on ${connection()} could not be recorded`))).to.have.length(1);
      });

      it('warns once and records nothing where the table is missing, and leaves tracked writes alone', async () => {
        const Invoice = await invoice();
        await db.dropCoverage(dialect);
        await coverage.record(undefined, T(1));
        await coverage.record(undefined, T(2));

        expect(db.warnings()).to.deep.eq([noTable(connection())]);
        expect(await since('invoice')).to.eq(undefined);
        await Invoice.insert({ id: 'i1', status: 'draft' });
        expect(await db.rows('invoice', dialect)).to.have.length(1);
      });
    });
  }
});
