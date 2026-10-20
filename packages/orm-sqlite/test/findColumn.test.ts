import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { findColumn, Orm } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

describe('sqlite findColumn', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('fc_users', (table) => {
        table.int('Id').primaryKey();
        table.string('Role');
      });
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('finds a column of tableInfo() by a name in another case, spelled as the table spells it', async () => {
    const role = findColumn(await driver().tableInfo('fc_users'), 'role');

    expect(role?.Name).to.eq('Role');
    await driver().insert().into('fc_users').values({ Id: 1, [role!.Name]: 'admin' });
    expect(await driver().select().columns([role!.Name]).from('fc_users')).to.deep.eq([{ Role: 'admin' }]);
  });
});
