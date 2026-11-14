import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, DateTime as DateTimeColumn, Model, ModelBase, Orm, Primary, QueryContext } from '@spinajs/orm';
import * as chai from 'chai';
import { DateTime } from 'luxon';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

const expect = chai.expect;
const AT = 1794612404654;

@Connection('sqlite')
@Model('dt_seconds')
class SecondsDoc extends ModelBase<SecondsDoc> {
  @Primary()
  public Id: number;

  @DateTimeColumn()
  public At: DateTime;
}

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

async function storedTypes(table: string): Promise<string[]> {
  const rows = (await driver().executeOnDb(`SELECT typeof(At) AS t FROM ${table} ORDER BY Id`, [], QueryContext.Select)) as { t: string }[];
  return rows.map((r) => r.t);
}

describe('sqlite @DateTime on an INTEGER column', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver().executeOnDb('CREATE TABLE dt_seconds (Id INTEGER PRIMARY KEY, At INTEGER NOT NULL)', [], QueryContext.Schema);
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('writes unix seconds into a column declared INTEGER in upper case', async () => {
    await SecondsDoc.insert({ Id: 1, At: DateTime.fromMillis(AT) });
    const doc = new SecondsDoc({ Id: 2, At: DateTime.fromMillis(AT + 5000) });
    await doc.insert();

    expect(await storedTypes('dt_seconds')).to.deep.eq(['integer', 'integer']);
    const rows = (await driver().executeOnDb('SELECT At FROM dt_seconds ORDER BY Id', [], QueryContext.Select)) as { At: number }[];
    expect(rows.map((r) => r.At)).to.deep.eq([Math.floor(AT / 1000), Math.floor(AT / 1000) + 5]);
    expect((await SecondsDoc.where('Id', 1).first())!.At.toMillis()).to.eq(Math.floor(AT / 1000) * 1000);
  });
});
