import { expect } from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { Orm, OrmMigrationGuard } from '@spinajs/orm';

import { HISTORY_COVERAGE_TABLE } from '../src/coverage-table.js';
import { HistoryCoverage, registerHistory } from '../src/index.js';
import { HistoryDb } from './support/db.js';

describe('history coverage at boot', function () {
  this.timeout(60000);
  let db: HistoryDb;
  const since = (): Promise<Date | undefined> => DI.resolve(HistoryCoverage).since('history', db.connectionName('sqlite'), 'invoice');

  before(async () => {
    db = await HistoryDb.open();
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.migrateCoverage('sqlite');
    await db.define({ name: 'Invoice', table: 'invoice', columns: { status: 'TEXT' }, decorate: (c) => registerHistory(c) }, 'sqlite');
  });

  afterEach(async () => {
    await db.clear();
  });

  it('records nothing when a migration tool boots the ORM, as this harness does', async () => {
    DI.emit('di.resolved.Orm', DI.RootContainer, DI.get(Orm));
    expect(await since()).to.eq(undefined);
    expect(await db.rows(HISTORY_COVERAGE_TABLE, 'sqlite')).to.deep.eq([]);
  });

  it('records what the application tracks when the ORM has booted, at the instant of the boot', async () => {
    DI.uncache(OrmMigrationGuard);
    await DI.resolve(OrmMigrationGuard, [{ Enabled: true }]);
    try {
      const before = Date.now();
      DI.emit('di.resolved.Orm', DI.RootContainer, DI.get(Orm));
      // `since` waits for the pass the event started.
      expect((await since())?.getTime()).to.be.at.least(before);
    } finally {
      DI.uncache(OrmMigrationGuard);
      await DI.resolve(OrmMigrationGuard, [{ Enabled: false }]);
    }
  });
});
