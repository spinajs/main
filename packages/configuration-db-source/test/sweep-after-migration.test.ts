import { expect } from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm, OrmMigrationGuard, OrmMigrator } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import { testHost } from '@spinajs/authz-testing';

import { DbConfig, DbConfigSourceBotstrapper, DbConfigValueConverter, DbConfigWatcher } from '../src/index.js';

const SLUG = 'sweepAfterMigration.limit';

async function rowWithin(ms: number): Promise<DbConfig | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const row = await DbConfig.where('Slug', SLUG).first();
    if (row || Date.now() > deadline) {
      return row ?? undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('exposed options after migrateTestDatabase', function () {
  this.timeout(10000);

  let bootstrapper: DbConfigSourceBotstrapper;

  before(async () => {
    await testHost.installHost();
    testHost.config().set(['logger'], { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] });
    testHost.config().set(['db'], { DefaultConnection: 'sqlite', Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite' }] });
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

    DI.register({ path: SLUG, options: { expose: true, defaultValue: 20, exposeOptions: { type: 'number', group: 'test' } } }).asValue('__configuration_property__');
  });

  // each test migrates a database of its own, so neither sees a row the other's sweep wrote
  beforeEach(async () => {
    bootstrapper = new DbConfigSourceBotstrapper();
    (bootstrapper as unknown as { Converter: DbConfigValueConverter }).Converter = await DI.resolve(DbConfigValueConverter);
    await bootstrapper.bootstrap();

    await migrateTestDatabase();
  });

  afterEach(async () => {
    await DI.get(DbConfigWatcher)?.dispose();
    DI.uncache(DbConfigWatcher);
    bootstrapper.unbind();

    await DI.get(Orm)?.dispose();
    DI.uncache(OrmMigrator);
    DI.uncache(OrmMigrationGuard);
    DI.uncache(Orm);
    DI.uncache('orm-driver-sqlite');
  });

  after(async () => {
    DI.unregister(SqliteOrmDriver);
    testHost.config().reset();
    await testHost.uninstallHost();
  });

  it('inserts the row of an exposed option once the migration run created the table', async () => {
    const row = await rowWithin(2000);

    expect(row?.Value).to.equal(20);
  });

  it('settles whenSwept() once the row is written', async () => {
    await bootstrapper.whenSwept();

    expect((await DbConfig.where('Slug', SLUG).first())?.Value).to.equal(20);
  });
});
