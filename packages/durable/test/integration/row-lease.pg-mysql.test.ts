import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import '@spinajs/orm-mysql';
import '@spinajs/orm-postgres';
import { quoteFor, sqlDialect } from '../../src/index.js';
import { bootDb } from '../support/env.js';
import { describeRowLease, LEASE_TABLE } from '../support/row-lease-cases.js';

const env = process.env;

/** Same variables as `scheduler/test/integration/real-db.ts`; a target whose host is unset is skipped. */
const TARGETS = [
  {
    name: 'postgres',
    enabled: !!env.SPINAJS_TEST_PG_HOST,
    connection: {
      Driver: 'orm-driver-postgres',
      Host: env.SPINAJS_TEST_PG_HOST,
      Port: Number(env.SPINAJS_TEST_PG_PORT ?? 5432),
      User: env.SPINAJS_TEST_PG_USER ?? 'postgres',
      Password: env.SPINAJS_TEST_PG_PASSWORD ?? 'postgres',
      Database: env.SPINAJS_TEST_PG_DB ?? 'spinajs_scheduler_test',
    },
  },
  {
    name: 'mysql',
    enabled: !!env.SPINAJS_TEST_MYSQL_HOST,
    connection: {
      Driver: 'orm-driver-mysql',
      Host: env.SPINAJS_TEST_MYSQL_HOST,
      Port: Number(env.SPINAJS_TEST_MYSQL_PORT ?? 3306),
      User: env.SPINAJS_TEST_MYSQL_USER ?? 'root',
      Password: env.SPINAJS_TEST_MYSQL_PASSWORD ?? '',
      Database: env.SPINAJS_TEST_MYSQL_DB ?? 'spinajs_scheduler_test',
    },
  },
];

for (const target of TARGETS) {
  (target.enabled ? describe : describe.skip)(`RowLease (${target.name})`, function () {
    this.timeout(30_000);
    after(() => DI.dispose());

    describeRowLease(async () => {
      const driver = await bootDb([{ ...target.connection, Name: 'default' }]);
      await driver.executeOnDb(`DROP TABLE IF EXISTS ${LEASE_TABLE}`, [], QueryContext.Schema);
      // quoted: Postgres folds unquoted identifiers to lower case, the query builder quotes them
      const q = quoteFor(sqlDialect(driver.Options.Driver, 'test table'));
      await driver.executeOnDb(`CREATE TABLE ${LEASE_TABLE} (${q('Id')} VARCHAR(64) PRIMARY KEY, ${q('Status')} VARCHAR(32), ${q('ClaimedBy')} VARCHAR(64), ${q('ClaimedUntil')} BIGINT, ${q('ClaimEpoch')} INTEGER NOT NULL DEFAULT 0)`, [], QueryContext.Schema);
      return driver;
    });
  });
}
