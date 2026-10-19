import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, Model, ModelBase, Orm, Primary, QueryContext, columnKind, extractModelDescriptor, lookupValue } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

const expect = chai.expect;

@Connection('sqlite')
@Model('gap_lookup')
class GapLookup extends ModelBase {
  @Primary()
  public Id: number;

  public Code: string;

  public Amount: number;
}

const column = (name: string) => extractModelDescriptor(GapLookup)!.Columns.find((c) => c.Name === name)!;

describe('sqlite column kinds and lookup values', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await (db().Connections.get('sqlite') as SqliteOrmDriver).executeOnDb('CREATE TABLE gap_lookup (Id INTEGER PRIMARY KEY, Code VARCHAR(16), Amount NUMERIC(10,2))', [], QueryContext.Schema);
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('names each column kind from the declared type', () => {
    expect(columnKind(column('Id'))).to.eq('integer');
    expect(columnKind(column('Code'))).to.eq('text');
    expect(columnKind(column('Amount'))).to.eq('decimal');
  });

  it('a lookup list without the text no row can hold finds the rows', async () => {
    await GapLookup.insert(new GapLookup({ Id: 1, Code: 'a', Amount: 1.5 }));
    await GapLookup.insert(new GapLookup({ Id: 2, Code: 'b', Amount: 2 }));

    const ids = ['1', 'abc', '2', '1.5'].map((t) => lookupValue(column('Id'), t)).filter((v) => v !== undefined);
    expect(ids).to.deep.eq([1, 2]);

    const found = (await GapLookup.query().whereIn('Id', ids)) as GapLookup[];
    expect(found.map((m) => m.Id).sort()).to.deep.eq([1, 2]);
  });
});
