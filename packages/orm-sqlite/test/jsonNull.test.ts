import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, Json, Model, ModelBase, Orm, Primary } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

@Connection('sqlite')
@Model('json_null_doc')
class JsonNullDoc extends ModelBase {
  @Primary()
  public Id: number;

  @Json()
  public Data: unknown;
}

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

async function raw(id: number): Promise<unknown> {
  const row = (await driver().select().from('json_null_doc').where('Id', id).first()) as { Data: unknown };
  return row.Data;
}

describe('sqlite @Json null', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('json_null_doc', (table) => {
        table.int('Id').primaryKey();
        table.text('Data');
      });
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('a static insert writes null as SQL NULL, which reads back as null', async () => {
    await JsonNullDoc.insert({ Id: 1, Data: null });

    expect(await raw(1)).to.eq(null);
    expect(((await JsonNullDoc.where('Id', 1).first()) as JsonNullDoc).Data).to.eq(null);
  });

  it('a model insert writes null as SQL NULL', async () => {
    await new JsonNullDoc({ Id: 2, Data: null }).insert();

    expect(await raw(2)).to.eq(null);
  });

  it('still writes values as JSON text and reads a stored text null as null', async () => {
    await JsonNullDoc.insert({ Id: 3, Data: { a: 1 } });
    await driver().insert().into('json_null_doc').values({ Id: 4, Data: 'null' });

    expect(await raw(3)).to.eq('{"a":1}');
    expect(((await JsonNullDoc.where('Id', 4).first()) as JsonNullDoc).Data).to.eq(null);
  });
});
