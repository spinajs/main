import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { ICompilerOutput, SchemaQueryBuilder } from '@spinajs/orm';

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
    const ddl = ([schema.createTable('t', (table) => {
      table.dateTime('At').notNull().default().dateTime();
      table.timestamp('Seen');
    }).toDB()].flat() as ICompilerOutput[]).map((o) => o.expression).join(';');

    expect(ddl).to.contain('`At` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)');
    expect(ddl).to.contain('`Seen` TIMESTAMP(3)');
  });
});
