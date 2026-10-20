import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, Model, ModelBase, Orm, Primary, UniqueViolation } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

@Connection('sqlite')
@Model('gap_split')
class GapSplit extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  public Code: string;
}

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ Id: i + 1, Name: `n${i}` }));

describe('sqlite insert split by bound-parameter limit', function () {
  this.timeout(60000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('gap_split', (table) => {
        table.int('Id').primaryKey().autoIncrement();
        table.string('Name');
        table.string('Code');
      });
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it("declares SQLite's bound-parameter limit", () => {
    expect(driver().MaxBindings).to.eq(32766);
  });

  it('inserts 20 000 rows of two columns through several statements', async () => {
    const result = await driver().insert().into('gap_split').values(rows(20000));

    expect(result.RowsAffected).to.eq(20000);
    expect(await driver().select().from('gap_split').selectCount()).to.eq(20000);
  });

  it('rolls every statement back when the last one fails', async () => {
    const payload = rows(20000);
    payload[19999].Id = 1;

    await expect(driver().insert().into('gap_split').values(payload)).to.be.rejectedWith(UniqueViolation);
    expect(await driver().select().from('gap_split').selectCount()).to.eq(0);
  });

  it('backfills the keys of 20 000 models inserted through several statements', async () => {
    const models = Array.from({ length: 20000 }, (_, i) => new GapSplit({ Name: `n${i}`, Code: `c${i}` }));

    await GapSplit.insert(models);

    const ids = models.map((m) => m.Id);
    expect(new Set(ids).size).to.eq(20000);
    expect(ids.every((id, i) => i === 0 || id > ids[i - 1])).to.eq(true);
  });
});
