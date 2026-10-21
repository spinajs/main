import { Bootstrapper, DI } from '@spinajs/di';
import '@spinajs/log';
import '@spinajs/orm-mysql';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Orm, OrmMigrator } from '@spinajs/orm';
import type { IDriverOptions, OrmDriver } from '@spinajs/orm';

import '../src/index.js';
import { typedRowCases } from './support/typed-rows.js';

/**
 * Env gate, as in packages/queue/test/migrations.mysql.test.ts: without SPINAJS_TEST_MYSQL_HOST the suite is pending.
 * Locally: `docker compose --profile test up -d mysql`, then SPINAJS_TEST_MYSQL_HOST=127.0.0.1 SPINAJS_TEST_MYSQL_PORT=13306
 * SPINAJS_TEST_MYSQL_PASSWORD=root SPINAJS_TEST_MYSQL_DB=test.
 */
const HOST = process.env.SPINAJS_TEST_MYSQL_HOST;
const CONNECTION: IDriverOptions = {
  Driver: 'orm-driver-mysql',
  Name: 'mysql',
  Host: HOST,
  Port: process.env.SPINAJS_TEST_MYSQL_PORT ? parseInt(process.env.SPINAJS_TEST_MYSQL_PORT, 10) : 3306,
  User: process.env.SPINAJS_TEST_MYSQL_USER ?? 'root',
  Password: process.env.SPINAJS_TEST_MYSQL_PASSWORD ?? '',
  Database: process.env.SPINAJS_TEST_MYSQL_DB ?? 'test',
  Migration: { OnStartup: true, Table: 'configuration_db_source_migrations' },
} as IDriverOptions;

class MysqlConfiguration extends FrameworkConfiguration {
  protected loadSources(): void {
    this.Sources = [];
  }

  protected onLoad(): unknown {
    return {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      db: { DefaultConnection: 'mysql', Connections: [CONNECTION] },
    };
  }
}

/** A clean schema for each boot: the migrations recreate the table and the test rows. */
async function dropTables(): Promise<void> {
  const driver = (await DI.resolve<OrmDriver>('orm-driver-mysql', [CONNECTION])) as OrmDriver;
  await driver.connect();
  try {
    await driver.schema().dropTable('configuration').ifExists();
    await driver.schema().dropTable(CONNECTION.Migration!.Table!).ifExists();
  } finally {
    await driver.disconnect();
  }
}

(HOST ? describe : describe.skip)('configuration rows on MySQL', function () {
  this.timeout(30000);

  before(() => {
    DI.register(MysqlConfiguration).as(Configuration);
  });

  beforeEach(async () => {
    DI.uncache(OrmMigrator);
    DI.uncache(Orm);
    DI.uncache(Configuration);
    await DI.resolve(Configuration);
    await dropTables();

    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }
    await DI.resolve(OrmMigrator);
  });

  afterEach(async () => {
    await DI.get(Orm)?.dispose();
    DI.uncache(OrmMigrator);
    DI.uncache(Orm);
    DI.uncache(Configuration);
  });

  after(() => {
    DI.unregister(MysqlConfiguration);
  });

  typedRowCases(
    'mysql-typed',
    async () => DI.get(Orm)!.Connections.get('mysql')!,
    () => new Promise((resolve) => setTimeout(resolve, 1000)),
  );
});
