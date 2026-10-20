import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Orm, QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

describe('sqlite lockTableShared', function () {
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

  it('takes the write lock with a write that touches no row', async () => {
    const sent: string[] = [];
    const executeOnDb = driver().executeOnDb.bind(driver());
    driver().executeOnDb = (stmt: string, params: unknown[], context: QueryContext) => (sent.push(stmt), executeOnDb(stmt, params, context));

    await driver().transaction(() => driver().lockTableShared('lock_t'));

    expect(sent).to.include('DELETE FROM `lock_t` WHERE 0');
  });

  it('resolves inside a transaction, whose own writes still land', async () => {
    await driver().insert().into('lock_t').values({ Id: 1 });

    await driver().transaction(async () => {
      await driver().lockTableShared('lock_t');
      await driver().insert().into('lock_t').values({ Id: 2 });
    });

    expect(await driver().select().from('lock_t').selectCount()).to.eq(2);
  });

  it('refuses to run outside a transaction', async () => {
    const err = await driver()
      .lockTableShared('lock_t')
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(err).to.be.instanceOf(InvalidOperation);
    expect((err as Error).message).to.eq('lockTableShared must run inside a transaction');
  });
});
