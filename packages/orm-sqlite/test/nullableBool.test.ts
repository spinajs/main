import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Bool, Connection, ICompilerOutput, Model, ModelBase, Orm, Primary } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

@Connection('sqlite')
@Model('nullable_bool')
class NullableFlag extends ModelBase {
  @Primary()
  public Id: number;

  @Bool({ nullable: true })
  public Flag: boolean | null;
}

@Connection('sqlite')
@Model('nullable_bool')
class CoercedFlag extends ModelBase {
  @Primary()
  public Id: number;

  @Bool()
  public Flag: boolean;
}

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

async function raw(id: number): Promise<unknown> {
  const row = (await driver().select().from('nullable_bool').where('Id', id).first()) as { Flag: unknown };
  return row.Flag;
}

describe('sqlite @Bool({ nullable: true })', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('nullable_bool', (table) => {
        table.int('Id').primaryKey();
        table.int('Flag');
      });
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('stores NULL, 0 and 1 and reads them back as null, false and true', async () => {
    await new NullableFlag({ Id: 1, Flag: null }).insert();
    await new NullableFlag({ Id: 2, Flag: false }).insert();
    await new NullableFlag({ Id: 3, Flag: true }).insert();

    expect(await raw(1)).to.eq(null);
    expect(await raw(2)).to.eq(0);
    expect(await raw(3)).to.eq(1);

    expect((await NullableFlag.where('Id', 1).first()).Flag).to.eq(null);
    expect((await NullableFlag.where('Id', 2).first()).Flag).to.eq(false);
    expect((await NullableFlag.where('Id', 3).first()).Flag).to.eq(true);
  });

  it('a static insert and an update write null as NULL', async () => {
    await NullableFlag.insert({ Id: 4, Flag: null });
    expect(await raw(4)).to.eq(null);

    await NullableFlag.insert({ Id: 5, Flag: true });
    await NullableFlag.update({ Flag: null }).where('Id', 5);
    expect(await raw(5)).to.eq(null);

    const model = await NullableFlag.where('Id', 4).first();
    model.Flag = false;
    await model.update();
    expect(await raw(4)).to.eq(0);
    model.Flag = null;
    await model.update();
    expect(await raw(4)).to.eq(null);
  });

  it('where(Flag, null) finds the NULL row and where(Flag, false) only the 0 row', async () => {
    await NullableFlag.insert({ Id: 1, Flag: null });
    await NullableFlag.insert({ Id: 2, Flag: false });
    await NullableFlag.insert({ Id: 3, Flag: true });

    expect((await NullableFlag.where('Flag', null)).map((m) => m.Id)).to.deep.eq([1]);
    expect((await NullableFlag.where('Flag', false)).map((m) => m.Id)).to.deep.eq([2]);
  });

  it('whereIn() binds null as NULL, which matches no row, so whereNull() is the way to find the NULL rows', async () => {
    await NullableFlag.insert({ Id: 1, Flag: null });
    await NullableFlag.insert({ Id: 2, Flag: false });
    await NullableFlag.insert({ Id: 3, Flag: true });

    expect((NullableFlag.query().whereIn('Flag', [null, true]).toDB() as ICompilerOutput).bindings).to.deep.eq([null, 1]);
    expect((await NullableFlag.query().whereIn('Flag', [null, true])).map((m) => m.Id)).to.deep.eq([3]);
    expect((await NullableFlag.query().whereNull('Flag')).map((m) => m.Id)).to.deep.eq([1]);

    const both = await NullableFlag.query().where(function () {
      this.whereIn('Flag', [true]).orWhere('Flag', null);
    });
    expect(both.map((m) => m.Id).sort()).to.deep.eq([1, 3]);
  });

  it('toJSON() emits null for a NULL flag and booleans for the others', async () => {
    await NullableFlag.insert({ Id: 1, Flag: null });
    await NullableFlag.insert({ Id: 2, Flag: false });

    expect((await NullableFlag.where('Id', 1).first()).toJSON()).to.include({ Id: 1, Flag: null });
    expect((await NullableFlag.where('Id', 2).first()).toJSON()).to.include({ Id: 2, Flag: false });
  });

  it('a model without the option still reads a NULL cell as false', async () => {
    await driver().insert().into('nullable_bool').values({ Id: 1, Flag: null });

    const read = await CoercedFlag.where('Id', 1).first();
    expect(read.Flag).to.eq(false);
    expect(read.toJSON()).to.include({ Flag: false });
  });

  it('@Bool() without the option still refuses a boolean | null property', () => {
    expect(() => {
      class Refused extends ModelBase {
        @Bool()
        public Flag: boolean | null;
      }
      return Refused;
    }).to.throw(InvalidArgument, 'must be boolean type, but is Object');
  });

  it('publishes the column as a nullable boolean in the model schema', () => {
    const descriptor = NullableFlag.getModelDescriptor();
    expect(descriptor.Schema).to.have.deep.nested.property('properties.Flag', { type: 'boolean', nullable: true });
    expect(descriptor.ResponseSchema).to.have.deep.nested.property('properties.Flag', { type: 'boolean', nullable: true });
  });
});
