/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-floating-promises */

import { SqlInsertQueryCompiler, SqlUpdateQueryCompiler } from './../src/compilers';
import { UuidModel } from './Models/UuidModel';
import { DI } from '@spinajs/di';
import { ConnectionConf, FakeSqliteDriver } from './fixture';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { Model1 } from './Models/Model1';
import * as chai from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import { Model2 } from './Models/Model2';
import chaiAsPromised from 'chai-as-promised';


const expect = chai.expect;
chai.use(chaiAsPromised);

describe('model generated queries', () => {
  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
  });

  afterEach(() => {
    DI.clearCache();
    sinon.restore();
  });

  it('static model update', async () => {
    await DI.resolve(Orm);
    const updateSpy = sinon.spy(SqlUpdateQueryCompiler.prototype, 'compile');

    await Model1.update({ Bar: '1' }).where({
      Id: 1,
    });

    await Model1.update({ Bar: '1' }).where({
      Id: null,
    });

    expect(updateSpy.returnValues[0].expression).to.eq('UPDATE `TestTable1` SET `Bar` = ? WHERE Id = ?');
    expect(updateSpy.returnValues[1].expression).to.eq('UPDATE `TestTable1` SET `Bar` = ? WHERE Id IS NULL');
  });

  it('model insert with uuid from static function', async () => {
    await DI.resolve(Orm);

    const insertSpy = sinon.spy(SqlInsertQueryCompiler.prototype, 'compile');

    await UuidModel.insert(new UuidModel());

    expect(insertSpy.returnValues[0].expression).to.eq('INSERT INTO `TestTable2` (`Id`) VALUES (?)');
    expect(typeof insertSpy.returnValues[0].bindings[0]).to.eq('string');
    expect(insertSpy.returnValues[0].bindings[0].length).to.eq(36);
  });

  it('insert should throw when fields are null', async () => {
    const tableInfoStub = sinon.stub(FakeSqliteDriver.prototype, 'tableInfo');
    tableInfoStub.withArgs('TestTable2', undefined).returns(
      new Promise((resolve) => {
        resolve([
          {
            Type: 'INT',
            MaxLength: 0,
            Comment: '',
            DefaultValue: null,
            NativeType: 'INT',
            Unsigned: false,
            Nullable: true,
            PrimaryKey: true,
            AutoIncrement: true,
            Name: 'Id',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
          },
          {
            Type: 'VARCHAR',
            MaxLength: 0,
            Comment: '',
            DefaultValue: null,
            NativeType: 'VARCHAR',
            Unsigned: false,
            Nullable: false,
            PrimaryKey: false,
            AutoIncrement: false,
            Name: 'Bar',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
          },
          {
            Type: 'VARCHAR',
            MaxLength: 0,
            Comment: '',
            DefaultValue: null,
            NativeType: 'VARCHAR',
            Unsigned: false,
            Nullable: true,
            PrimaryKey: false,
            AutoIncrement: false,
            Name: 'Far',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
          },
        ]);
      }),
    );
    await DI.resolve(Orm);
    const model = new Model2({
      Far: 'hello',
    });
    model.Bar = null;

    expect(model.insert()).to.be.rejected;

    const model2 = new Model2({
      Far: 'hello',
    });
    model2.Bar = "helo";
    expect(model2.insert()).to.be.fulfilled;
  });
});
