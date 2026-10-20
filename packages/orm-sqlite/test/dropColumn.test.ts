import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

describe('sqlite dropColumn', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('dc_t', (table) => {
        table.int('Id').primaryKey();
        table.string('Order');
        table.string('Role');
      });
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('drops a column whose name is a keyword', async () => {
    await driver()
      .schema()
      .alterTable('dc_t', (table) => table.dropColumn('Order'));

    expect((await driver().tableInfo('dc_t')).map((c) => c.Name)).to.deep.eq(['Id', 'Role']);
  });
});
