import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, Model, ModelBase, Orm, Primary } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

@Connection('sqlite')
@Model('gap_counter')
class GapCounter extends ModelBase {
  @Primary()
  public Id: number;

  public Hits: number;

  public Name: string;
}

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

describe('sqlite update increment', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('gap_counter', (table) => {
        table.int('Id').primaryKey();
        table.int('Hits').notNull();
        table.string('Name');
      });
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('lands every one of 10 concurrent increments', async () => {
    await driver().insert().into('gap_counter').values({ Id: 1, Hits: 0, Name: 'a' });

    await Promise.all(Array.from({ length: 10 }, () => driver().update().in('gap_counter').increment('Hits').where('Id', 1)));

    const row = (await driver().select().from('gap_counter').where('Id', 1).first()) as { Hits: number };
    expect(row.Hits).to.eq(10);
  });

  it('increments through Model.update next to set values and reports the rows it touched', async () => {
    await driver().insert().into('gap_counter').values({ Id: 1, Hits: 5, Name: 'a' });

    const hit = await GapCounter.update({ Name: 'b' }).increment('Hits', 2).where('Id', 1);
    const miss = await GapCounter.update({}).increment('Hits').where('Id', 2);

    expect(hit.RowsAffected).to.eq(1);
    expect(miss.RowsAffected).to.eq(0);

    const row = (await GapCounter.where('Id', 1).first()) as GapCounter;
    expect(row.Hits).to.eq(7);
    expect(row.Name).to.eq('b');
  });
});
