import { DI } from '@spinajs/di';
import { bootDb } from '../support/env.js';
import { REAL_DB_TARGETS } from '../support/real-db.js';
import { describeRowLease, LEASE_TABLE } from '../support/row-lease-cases.js';

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`RowLease (${target.name})`, function () {
    this.timeout(30_000);
    after(() => DI.dispose());

    describeRowLease(async () => {
      const driver = await bootDb([{ ...target.connection, Name: 'default' }]);
      await driver.schema().dropTable(LEASE_TABLE).ifExists();
      await driver.schema().createTable(LEASE_TABLE, (t) => {
        t.string('Id', 64).primaryKey();
        t.string('Status', 32);
        t.string('ClaimedBy', 64);
        t.bigint('ClaimedUntil');
        t.int('ClaimEpoch').notNull().default().value(0);
      });
      return driver;
    });
  });
}
