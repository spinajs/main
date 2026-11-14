import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, CreatedAt, DateTime as DateTimeColumn, Model, ModelBase, Orm, Primary, QueryContext } from '@spinajs/orm';
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

@Connection('sqlite')
@Model('dt_created')
class CreatedDoc extends ModelBase<CreatedDoc> {
  @Primary()
  public Id: number;

  @CreatedAt()
  public Created: DateTime;
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
    await driver().executeOnDb('CREATE TABLE dt_created (Id INTEGER PRIMARY KEY, Created INTEGER)', [], QueryContext.Schema);
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
    expect((await SecondsDoc.where('Id', 1).first()).At.toMillis()).to.eq(Math.floor(AT / 1000) * 1000);
  });

  it('stamps @CreatedAt as unix seconds into a column declared INTEGER', async () => {
    const before = Math.floor(Date.now() / 1000);
    await new CreatedDoc({ Id: 1 }).insert();

    const rows = (await driver().executeOnDb('SELECT Created, typeof(Created) AS t FROM dt_created', [], QueryContext.Select)) as { Created: number; t: string }[];
    expect(rows[0].t).to.eq('integer');
    expect(rows[0].Created).to.be.within(before, Math.floor(Date.now() / 1000));
  });
});
