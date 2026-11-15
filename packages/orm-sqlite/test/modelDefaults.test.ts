import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, Model, ModelBase, Orm, Primary, QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

@Connection('sqlite')
@Model('defaults_row')
class DefaultsRow extends ModelBase {
  @Primary()
  public Id: number;

  public Code: string;

  public Seen: string;
}

describe('sqlite column defaults on a new model', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await (db().Connections.get('sqlite') as SqliteOrmDriver).executeOnDb("CREATE TABLE defaults_row (Id INTEGER PRIMARY KEY, Code TEXT DEFAULT 'abc', Seen TEXT DEFAULT CURRENT_TIMESTAMP)", [], QueryContext.Schema);
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it("starts with a literal default's value and leaves an expression default to the insert", async () => {
    const row = new DefaultsRow();
    expect(row.Code).to.equal('abc');
    expect(row.Seen).to.equal(undefined);

    await DefaultsRow.insert(row);
    const [stored] = await DefaultsRow.query().where({ Id: row.Id });
    expect(stored.Code).to.equal('abc');
    expect(stored.Seen).to.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('refuses a multi-row insert that sets an expression-defaulted column in some rows only', async () => {
    const error = await DefaultsRow.insert([new DefaultsRow({ Seen: '2026-01-01 00:00:00' }), new DefaultsRow()]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as Error | undefined)?.message).to.contain('sqlite has no DEFAULT inside VALUES');
  });
});
