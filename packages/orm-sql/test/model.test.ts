import { ICompilerOutput } from '@spinajs/orm';
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-floating-promises */

import { SqlInsertQueryCompiler, SqlUpdateQueryCompiler } from './../src/compilers.js';
import { DI } from '@spinajs/di';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';
import { Configuration } from '@spinajs/configuration';
import { Orm, SelectQueryBuilder } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';

import './Models/JoinModel.js';
import { Model1 } from './Models/Model1.js';
import { Model2 } from './Models/Model2.js';
import './Models/RelationModel.js';
import './Models/RelationModel2.js';
import './Models/RelationModel3.js';
import './Models/RelationModel4.js';
import { UuidModel } from './Models/UuidModel.js';
import { Model3 } from './Models/Model3.js';
import { Model4 } from './Models/Model4.js';
import "@spinajs/log";
import { User } from './Models/User.js';
import { UserMetadata } from './Models/UserMetadata.js';
import { RelationModel3 } from './Models/RelationModel3.js';

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
      Id: null as any,
    });

    expect(updateSpy.returnValues[0].expression).to.eq('UPDATE `TestTable1` SET `Bar` = ? WHERE `Id` = ?');
    expect(updateSpy.returnValues[1].expression).to.eq('UPDATE `TestTable1` SET `Bar` = ? WHERE `Id` IS NULL');
  });

  it('Should model query join work', async () => {

    const tableInfoStub = sinon.stub(FakeSqliteDriver.prototype, 'tableInfo');
    tableInfoStub
      .withArgs('TestTable4', undefined)
      .returns(
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
              Name: 'Bar',
              Converter: null as any,
              Schema: 'sqlite',
              Unique: false,
              Uuid: false,
              Ignore: false,
              IsForeignKey: false,
              ForeignKeyDescription: null as any,
              Aggregate: false,
              Virtual: false,
            },


          ]);
        }),
      )

    await DI.resolve(Orm);

    const result = Model3.query()
      .innerJoin(Model4, function () {
        this.where({
          Bar: 1,
        } as any);
      })
      .toDB() as ICompilerOutput;

    const result2 = Model3.query()
      .leftJoin(Model4, function () {

        // TODO: fix this cast in nested where
        this.where({
          Bar: 1,
        } as any);
      })
      .toDB() as ICompilerOutput;

    expect(result.expression).to.equal('SELECT * FROM `TestTable3` as `$TestTable3$` INNER JOIN `TestTable4` as `$Model4$` ON `$TestTable3$`.Id = `$Model4$`.model3_id WHERE ( `$Model4$`.`Bar` = ? )');
    expect(result2.expression).to.equal('SELECT * FROM `TestTable3` as `$TestTable3$` LEFT JOIN `TestTable4` as `$Model4$` ON `$TestTable3$`.Id = `$Model4$`.model3_id WHERE ( `$Model4$`.`Bar` = ? )');
  });

  it('model should execute scope function', async () => {
    await DI.resolve(Orm);

    const result = (Model1.query().whereIdIsGreaterThan(999) as SelectQueryBuilder).toDB();
    expect(result.expression).to.equal('SELECT * FROM `TestTable1` WHERE `Id` >= ?');
    expect(result.bindings![0]).to.eq(999);
  });

  it('model insert with uuid from static function', async () => {
    await DI.resolve(Orm);

    const insertSpy = sinon.spy(SqlInsertQueryCompiler.prototype, 'compile');

    await UuidModel.insert(new UuidModel());

    expect(insertSpy.returnValues[0].expression).to.eq('INSERT INTO `TestTable2` (`Id`) VALUES (?)');
    expect(typeof insertSpy.returnValues[0].bindings[0]).to.eq('string');
    expect(insertSpy.returnValues[0].bindings[0].length).to.eq(36);
  });

  it('model join with select and column alias', async () => {

    const tableInfoStub = sinon.stub(FakeSqliteDriver.prototype, 'tableInfo');
    tableInfoStub.withArgs('users_metadata', undefined).returns(
      new Promise((res) => {
        res([
          {
            Type: 'VARCHAR',
            MaxLength: 0,
            Comment: '',
            DefaultValue: null,
            NativeType: 'VARCHAR',
            Unsigned: false,
            Nullable: true,
            PrimaryKey: true,
            AutoIncrement: true,
            Name: 'Key',
            Converter: null as any,
            Schema: 'sqlite',
            Unique: false,
            Uuid: true,
            Ignore: false,
            IsForeignKey: false,
            ForeignKeyDescription: null as any,
            Aggregate: false,
            Virtual: false,
          },
          {
            Type: 'VARCHAR',
            MaxLength: 0,
            Comment: '',
            DefaultValue: null,
            NativeType: 'VARCHAR',
            Unsigned: false,
            Nullable: true,
            PrimaryKey: true,
            AutoIncrement: true,
            Name: 'Value',
            Converter: null as any,
            Schema: 'sqlite',
            Unique: false,
            Uuid: true,
            Ignore: false,
            IsForeignKey: false,
            ForeignKeyDescription: null as any,
            Aggregate: false,
            Virtual: false,
          },
        ]);
      }),
    );

    await DI.resolve(Orm);

    const result = User.select().leftJoin(UserMetadata, function () {
      this.where('Key', 'user:niceName');
    }, function () {
      this.select('Value', 'user:niceName');
    }).toDB() as ICompilerOutput;


    expect(result.expression).to.equal('SELECT `$users$`.*,`$UserMetadata$`.`Value` as `user:niceName` FROM `users` as `$users$` LEFT JOIN `users_metadata` as `$UserMetadata$` ON `$users$`.Id = `$UserMetadata$`.user_id WHERE ( `$UserMetadata$`.`Key` = ? )');
    expect(result.bindings![0]).to.eq('user:niceName');
  });

  it('model join with exists', async () => {
    await DI.resolve(Orm);

    const tableInfoStub = sinon.stub(FakeSqliteDriver.prototype, 'tableInfo');
    tableInfoStub.withArgs('users_metadata', undefined).returns(
      new Promise((res) => {
        res([
          {
            Type: 'VARCHAR',
            MaxLength: 0,
            Comment: '',
            DefaultValue: null,
            NativeType: 'VARCHAR',
            Unsigned: false,
            Nullable: true,
            PrimaryKey: true,
            AutoIncrement: true,
            Name: 'Key',
            Converter: null as any,
            Schema: 'sqlite',
            Unique: false,
            Uuid: true,
            Ignore: false,
            IsForeignKey: false,
            ForeignKeyDescription: null as any,
            Aggregate: false,
            Virtual: false,
          },
          {
            Type: 'VARCHAR',
            MaxLength: 0,
            Comment: '',
            DefaultValue: null,
            NativeType: 'VARCHAR',
            Unsigned: false,
            Nullable: true,
            PrimaryKey: true,
            AutoIncrement: true,
            Name: 'Value',
            Converter: null as any,
            Schema: 'sqlite',
            Unique: false,
            Uuid: true,
            Ignore: false,
            IsForeignKey: false,
            ForeignKeyDescription: null as any,
            Aggregate: false,
            Virtual: false,
          },
        ]);
      }),
    );

    const result = User.select().leftJoin(UserMetadata, function () {
      this.where('Key', 'user:niceName');
    }, function () {
      this.select('Value', 'user:niceName');
    }).whereExist("Metadata", function () {
      this.where('Key', "user:niceName");
      this.where('Value', 'testValue');
    }).toDB() as ICompilerOutput;

    expect(result.expression).to.equal('SELECT `$users$`.*,`$UserMetadata$`.`Value` as `user:niceName` FROM `users` as `$users$` LEFT JOIN `users_metadata` as `$UserMetadata$` ON `$users$`.Id = `$UserMetadata$`.user_id WHERE ( `$UserMetadata$`.`Key` = ? ) AND EXISTS ( SELECT * FROM `users_metadata` as `users_metadata_exists` WHERE `users_metadata_exists`.`Key` = ? AND `users_metadata_exists`.`Value` = ? AND user_id = `$users$`.`Id` )');
    expect(result.bindings![0]).to.eq('user:niceName');
    expect(result.bindings![1]).to.eq('user:niceName');
    expect(result.bindings![2]).to.eq('testValue');

  });

  it('Should whereExists use table name as alias', async () => {
    await DI.resolve(Orm);

    const q = User.select().whereExist("Metadata", function () {
      this.where('Key', "user:niceName");
      this.where('Value', 'testValue');
    }).toDB() as ICompilerOutput;

    expect(q.expression).to.equal('SELECT * FROM `users` WHERE EXISTS ( SELECT * FROM `users_metadata` as `users_metadata_exists` WHERE `users_metadata_exists`.`Key` = ? AND `users_metadata_exists`.`Value` = ? AND user_id = `users`.`Id` )');
    expect(q.bindings![0]).to.eq('user:niceName');
    expect(q.bindings![1]).to.eq('testValue');

  });

  
  it('Should whereNotExists use table name as alias', async () => {
    await DI.resolve(Orm);

    const q = User.select().whereNotExists("Metadata", function () {
      this.where('Key', "user:niceName");
      this.where('Value', 'testValue');
    }).toDB() as ICompilerOutput;

    expect(q.expression).to.equal('SELECT * FROM `users` WHERE NOT EXISTS ( SELECT * FROM `users_metadata` as `users_metadata_exists` WHERE `users_metadata_exists`.`Key` = ? AND `users_metadata_exists`.`Value` = ? AND user_id = `users`.`Id` )');
    expect(q.bindings![0]).to.eq('user:niceName');
    expect(q.bindings![1]).to.eq('testValue');

  });

  it('should whereExists use table alias if exists', async () => {
    await DI.resolve(Orm);

    const q = User.select().setAlias('u').whereExist("Metadata", function () {
      this.where('Key', "user:niceName");
      this.where('Value', 'testValue');
    }).toDB() as ICompilerOutput;

    expect(q.expression).to.equal('SELECT `u`.* FROM `users` as `u` WHERE EXISTS ( SELECT * FROM `users_metadata` as `users_metadata_exists` WHERE `users_metadata_exists`.`Key` = ? AND `users_metadata_exists`.`Value` = ? AND user_id = `u`.`Id` )');
    expect(q.bindings![0]).to.eq('user:niceName');
    expect(q.bindings![1]).to.eq('testValue');
  });

  it('should whereNotExists use table alias if exists', async () => {
    await DI.resolve(Orm);

    const q = User.select().setAlias('u').whereNotExists("Metadata", function () {
      this.where('Key', "user:niceName");
      this.where('Value', 'testValue');
    }).toDB() as ICompilerOutput;

    expect(q.expression).to.equal('SELECT `u`.* FROM `users` as `u` WHERE NOT EXISTS ( SELECT * FROM `users_metadata` as `users_metadata_exists` WHERE `users_metadata_exists`.`Key` = ? AND `users_metadata_exists`.`Value` = ? AND user_id = `u`.`Id` )');
    expect(q.bindings![0]).to.eq('user:niceName');
    expect(q.bindings![1]).to.eq('testValue');
  });

  it('whereExists on ManyToMany relation should correlate through the junction table', async () => {
    await DI.resolve(Orm);

    // the EXISTS sub-query is correlated FROM the junction table (JoinTable) - a single
    // junction row linking the source row to any target already satisfies the check
    const q = RelationModel3.select().whereExist('Models').toDB() as ICompilerOutput;

    expect(q.expression).to.equal('SELECT * FROM `RelationTable3` WHERE EXISTS ( SELECT * FROM `JoinTable` as `JoinTable_exists` WHERE owner_id = `RelationTable3`.`Id` )');
  });

  it('whereExists on ManyToMany relation should join the target so the callback resolves', async () => {
    await DI.resolve(Orm);

    // a callback narrows the target, so the target table is joined through the junction
    const q = RelationModel3.select().whereExist('Models', function () {
      this.where('Id', 1);
    }).toDB() as ICompilerOutput;

    expect(q.expression).to.equal('SELECT * FROM `RelationTable3` WHERE EXISTS ( SELECT * FROM `JoinTable` as `JoinTable_exists` RIGHT JOIN `RelationTable4` as `$RelationModel4$` ON `JoinTable_exists`.target_id = `$RelationModel4$`.Id WHERE ( `$RelationModel4$`.`Id` = ? ) AND owner_id = `RelationTable3`.`Id` )');
    expect(q.bindings![0]).to.eq(1);
  });

  it('whereNotExists on ManyToMany relation should correlate through the junction table', async () => {
    await DI.resolve(Orm);

    const q = RelationModel3.select().whereNotExists('Models').toDB() as ICompilerOutput;

    expect(q.expression).to.equal('SELECT * FROM `RelationTable3` WHERE NOT EXISTS ( SELECT * FROM `JoinTable` as `JoinTable_exists` WHERE owner_id = `RelationTable3`.`Id` )');
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
            Converter: null as any,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
            IsForeignKey: false,
            ForeignKeyDescription: null as any,
            Aggregate: false,
            Virtual: false
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
            Converter: null as any,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
            IsForeignKey: false,
            ForeignKeyDescription: null as any,
            Aggregate: false,
            Virtual: false
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
            Converter: null as any,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
            IsForeignKey: false,
            ForeignKeyDescription: null as any,
            Aggregate: false,
            Virtual: false
          },
        ]);
      }),
    );
    await DI.resolve(Orm);
    const model = new Model2({
      Far: 'hello',
    });
    model.Bar = null as any;

    expect(model.insert()).to.be.rejected;

    const model2 = new Model2({
      Far: 'hello',
    });
    model2.Bar = 'helo';
    expect(model2.insert()).to.be.fulfilled;
  });
});
