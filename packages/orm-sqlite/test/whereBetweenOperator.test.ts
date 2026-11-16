import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { BelongsTo, Connection, DateTime as DateTimeColumn, Model, ModelBase, Orm, Primary, SingleRelation, SqlOperator, Wrapper } from '@spinajs/orm';
import * as chai from 'chai';
import { DateTime } from 'luxon';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

const expect = chai.expect;
const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);

@Connection('sqlite')
@Model('wbo_row')
class Row extends ModelBase<Row> {
  @Primary()
  public Id: number;

  public N: number;

  @DateTimeColumn()
  public At: DateTime;
}

@Connection('sqlite')
@Model('wbo_target')
class Target extends ModelBase<Target> {
  @Primary()
  public Id: number;

  public N: number;
}

@Connection('sqlite')
@Model('wbo_owner')
class Owner extends ModelBase<Owner> {
  @Primary()
  public Id: number;

  public N: number;

  public target_id: number;

  @BelongsTo(Target, 'target_id')
  public Target: SingleRelation<Target>;
}

describe('where(column, BETWEEN, pair)', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    const schema = db().Connections.get('sqlite')!.schema();
    await schema.createTable('wbo_row', (table) => {
      table.int('Id').primaryKey();
      table.int('N');
      table.dateTime('At');
    });
    await schema.createTable('wbo_target', (table) => {
      table.int('Id').primaryKey();
      table.int('N');
    });
    await schema.createTable('wbo_owner', (table) => {
      table.int('Id').primaryKey();
      table.int('N');
      table.int('target_id');
    });
    await db().reloadTableInfo();

    for (let n = 1; n <= 5; n++) {
      await Row.insert({ Id: n, N: n, At: DateTime.fromMillis(START + n * DAY) });
    }
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('where(column, BETWEEN, pair) selects the closed range', async () => {
    const rows = await Row.where('N', SqlOperator.BETWEEN, [2, 4]).orderBy('N');
    expect(rows.map((r) => r.N)).to.deep.equal([2, 3, 4]);
  });

  it('where(column, NOT_BETWEEN, pair) selects the rest', async () => {
    const rows = await Row.where('N', SqlOperator.NOT_BETWEEN, [2, 4]).orderBy('N');
    expect(rows.map((r) => r.N)).to.deep.equal([1, 5]);
  });

  it('orWhere keeps the OR', async () => {
    const rows = await Row.where('N', 1).orWhere('N', SqlOperator.BETWEEN, [4, 5]).orderBy('N');
    expect(rows.map((r) => r.N)).to.deep.equal([1, 4, 5]);
  });

  it('refuses a value that is not a pair', () => {
    expect(() => Row.where('N', SqlOperator.BETWEEN, [1])).to.throw(InvalidArgument);
    expect(() => Row.where('N', SqlOperator.BETWEEN, [1, 2, 3])).to.throw(InvalidArgument);
    expect(() => Row.where('N', SqlOperator.BETWEEN, 3 as any)).to.throw(InvalidArgument);
    expect(() => Row.where('N', SqlOperator.NOT_BETWEEN, [1, undefined])).to.throw(InvalidArgument);
    expect(() => Row.where('N', SqlOperator.BETWEEN, [NaN, 2])).to.throw(InvalidArgument);
    expect(() => Row.where('N', 'BETWEEN' as SqlOperator, [null, 2])).to.throw(InvalidArgument);
  });

  it('converts the bounds of a @DateTime column like a single value', async () => {
    const rows = await Row.where('At', SqlOperator.BETWEEN, [DateTime.fromMillis(START + 2 * DAY), DateTime.fromMillis(START + 3 * DAY).setZone('Asia/Kolkata')]).orderBy('N');
    expect(rows.map((r) => r.N)).to.deep.equal([2, 3]);
  });

  it('ranges over a wrapped column', async () => {
    const rows = await Row.where(Wrapper.Text('N'), SqlOperator.BETWEEN, ['2', '4']).orderBy('N');
    expect(rows.map((r) => r.N)).to.deep.equal([2, 3, 4]);
  });

  it('qualifies the column when populate() joins a table with the same column', async () => {
    await Target.insert({ Id: 1, N: 100 });
    await Target.insert({ Id: 2, N: 3 });
    await Owner.insert({ Id: 1, N: 2, target_id: 1 });
    await Owner.insert({ Id: 2, N: 9, target_id: 2 });

    const owners = await Owner.where('N', SqlOperator.BETWEEN, [1, 4]).populate('Target');
    expect(owners.map((o) => o.Id)).to.deep.equal([1]);
    expect(owners[0].Target.Value!.N).to.equal(100);
  });
});
