import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

describe('sqlite lockTable', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('lock_t', (table) => {
        table.int('Id').primaryKey();
      });
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('sends no statement', () => {
    expect(driver().schema().lockTable('lock_t').toDB()).to.deep.eq([]);
  });

  it('resolves inside a transaction, whose own writes still land', async () => {
    await driver().transaction(async () => {
      await driver().schema().lockTable('lock_t');
      await driver().insert().into('lock_t').values({ Id: 1 });
    });

    expect(await driver().select().from('lock_t').selectCount()).to.eq(1);
  });

  it('refuses to run outside a transaction', async () => {
    const err = await driver()
      .schema()
      .lockTable('lock_t')
      .execute()
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(err).to.be.instanceOf(InvalidOperation);
    expect((err as Error).message).to.eq('lockTable(lock_t) holds its lock until the transaction ends, so it needs one: await it inside driver.transaction()');
  });
});
