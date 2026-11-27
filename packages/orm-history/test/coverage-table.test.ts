import { expect } from 'chai';
import 'mocha';

import { HISTORY_COVERAGE_TABLE, deleteCoverage, holdsCoverageTable, insertCoverage, readCoverage, restartCoverage, writeCoverageColumns } from '../src/coverage-table.js';
import type { CoverageKey } from '../src/coverage-table.js';
import { HistoryDb } from './support/db.js';

const T = (minute: number): Date => new Date(Date.UTC(2026, 9, 1, 12, minute));
const COLUMNS = { recorded: ['id', 'status'], skipped: ['secret'] };
const WIDER = { recorded: ['id', 'secret', 'status'], skipped: [] };

describe('the history_coverage table', function () {
  this.timeout(60000);
  let db: HistoryDb;

  before(async () => {
    db = await HistoryDb.open();
  });

  after(async () => {
    await db?.close();
  });

  it('is on the default connection after the migration the package ships', async () => {
    expect(await db.rows(HISTORY_COVERAGE_TABLE, 'sqlite')).to.deep.eq([]);
  });

  for (const dialect of HistoryDb.dialects()) {
    describe(dialect, () => {
      const key = (entity = 'invoice'): CoverageKey => ({ trail: 'history', connection: db.connectionName(dialect), entity });

      beforeEach(async () => {
        await db.migrateCoverage(dialect);
      });

      afterEach(async () => {
        if (dialect !== 'sqlite') await db.dropCoverage(dialect);
      });

      it('has the key columns, the instant and the column lists, and is told from a missing table', async () => {
        const columns = await db.driver(dialect).tableInfo(HISTORY_COVERAGE_TABLE);
        expect(columns.map((c) => c.Name).sort()).to.deep.eq(['columns', 'connection', 'entity', 'id', 'since', 'trail']);
        expect(await holdsCoverageTable(db.driver(dialect))).to.eq(true);
        await db.dropCoverage(dialect);
        expect(await holdsCoverageTable(db.driver(dialect))).to.eq(false);
      });

      it('keeps one row per trail, connection and entity: a second insert is ignored and the first instant stays', async () => {
        const driver = db.driver(dialect);
        await insertCoverage(driver, key(), COLUMNS, T(1));
        await insertCoverage(driver, key(), WIDER, T(2));
        await insertCoverage(driver, key('note'), COLUMNS, T(3));

        expect(await readCoverage(driver, key())).to.deep.eq({ since: T(1), columns: COLUMNS });
        expect(await readCoverage(driver, key('note'))).to.deep.eq({ since: T(3), columns: COLUMNS });
        expect(await readCoverage(driver, key('never'))).to.eq(undefined);
        expect(await db.rows(HISTORY_COVERAGE_TABLE, dialect)).to.have.length(2);
      });

      it('a restart moves the instant forward only and always writes the column lists', async () => {
        const driver = db.driver(dialect);
        await insertCoverage(driver, key(), COLUMNS, T(5));
        await restartCoverage(driver, key(), WIDER, T(9));
        expect(await readCoverage(driver, key())).to.deep.eq({ since: T(9), columns: WIDER });

        await restartCoverage(driver, key(), COLUMNS, T(7));
        expect(await readCoverage(driver, key())).to.deep.eq({ since: T(9), columns: COLUMNS });

        await writeCoverageColumns(driver, key(), WIDER);
        expect(await readCoverage(driver, key())).to.deep.eq({ since: T(9), columns: WIDER });
      });

      it('deletes the rows of the named entities of one connection', async () => {
        const driver = db.driver(dialect);
        for (const entity of ['invoice', 'note', 'plan']) await insertCoverage(driver, key(entity), COLUMNS, T(1));
        await insertCoverage(driver, { ...key(), connection: 'elsewhere' }, COLUMNS, T(1));
        await deleteCoverage(driver, db.connectionName(dialect), ['invoice', 'note']);

        expect((await db.rows(HISTORY_COVERAGE_TABLE, dialect)).map((r) => [r.connection, r.entity])).to.deep.eq([
          [db.connectionName(dialect), 'plan'],
          ['elsewhere', 'invoice'],
        ]);
      });

      it('reads column lists it cannot parse as unknown', async () => {
        const driver = db.driver(dialect);
        await insertCoverage(driver, key(), COLUMNS, T(1));
        await driver.update().in(HISTORY_COVERAGE_TABLE).update({ columns: 'not json' }).where('entity', 'invoice');
        expect(await readCoverage(driver, key())).to.deep.eq({ since: T(1), columns: undefined });
      });
    });
  }
});
