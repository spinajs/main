import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { SchemaQueryBuilder } from '@spinajs/orm';

import { MySqlOrmDriver } from '../src/index.js';

describe('mysql datetime columns', function () {
  this.timeout(15000);

  let driver: MySqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-datetime-test', Driver: 'orm-driver-mysql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('keeps milliseconds, and the default carries the column precision', () => {
    const schema = driver.Container.resolve(SchemaQueryBuilder, [driver]);
    const ddl = [schema.createTable('t', (table) => {
      table.dateTime('At').notNull().default().dateTime();
      table.timestamp('Seen');
    }).toDB()].flat().map((o) => o.expression).join(';');

    expect(ddl).to.contain('`At` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)');
    expect(ddl).to.contain('`Seen` TIMESTAMP(3)');
  });

  // MySQL 5.7 defaults to explicit_defaults_for_timestamp=OFF: a TIMESTAMP without the NULL attribute after the first
  // becomes NOT NULL DEFAULT '0000-00-00 00:00:00', which strict mode refuses ("Invalid default value").
  it('says NULL for a nullable TIMESTAMP, so the DDL means the same under explicit_defaults_for_timestamp OFF and ON', () => {
    const schema = driver.Container.resolve(SchemaQueryBuilder, [driver]);
    const ddl = [schema.createTable('t', (table) => {
      table.timestamp('CreatedAt').notNull().default().dateTime();
      table.timestamp('ExecutedAt');
      table.timestamp('Required').notNull();
      table.dateTime('At');
    }).toDB()].flat().map((o) => o.expression).join(';');

    expect(ddl).to.contain('`ExecutedAt` TIMESTAMP(3) NULL');
    expect(ddl).to.match(/`CreatedAt` TIMESTAMP\(3\) NOT NULL DEFAULT/);
    expect(ddl).to.contain('`Required` TIMESTAMP(3) NOT NULL');
    expect(ddl).to.not.match(/`At` DATETIME\(3\) NULL/);
  });

  it('says NULL for a nullable TIMESTAMP added by ALTER TABLE', () => {
    const schema = driver.Container.resolve(SchemaQueryBuilder, [driver]);
    const ddl = [schema.alterTable('t', (table) => {
      table.timestamp('FinishedAt');
    }).toDB()].flat().map((o) => o.expression).join(';');

    expect(ddl).to.contain('`FinishedAt` TIMESTAMP(3) NULL');
  });
});
