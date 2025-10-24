/* eslint-disable prettier/prettier */
import './../src/bootstrap.js';
import { NonDbPropertyHydrator, DbPropertyHydrator, ModelHydrator, OneToOneRelationHydrator, JunctionModelPropertyHydrator } from './../src/hydrators.js';
import { ModelNoConnection } from './mocks/models/ModelNoConnection.js';
import { ModelNoDescription } from './mocks/models/ModelNoDescription.js';
import { SelectQueryBuilder } from './../src/builders.js';
import { Model1 } from './mocks/models/Model1.js';
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import * as chai from 'chai';
import _ from 'lodash';
import 'mocha';
import { Orm } from '../src/index.js';
import { FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeInsertQueryCompiler, FakeUpdateQueryCompiler, ConnectionConf, FakeMysqlDriver, FakeConverter, FakeTableQueryCompiler, FakeServerResponseMapper } from './misc.js';
import { IModelDescriptor, SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, InsertBehaviour, DatetimeValueConverter, TableQueryCompiler, ServerResponseMapper } from '../src/interfaces.js';
import * as sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import chaiSubset from 'chai-subset';
import { RawModel } from './mocks/models/RawModel.js';
import { Model, Connection } from '../src/decorators.js';
import { ModelBase, _modelProxyFactory } from './../src/model.js';
import { Model4, Model6, ModelDisc1, ModelDisc2, ModelDiscBase } from './mocks/models/index.js';
import { ModelWithScopeQueryScope } from './mocks/models/ModelWithScope.js';
import { StandardModelDehydrator, StandardModelWithRelationsDehydrator } from './../src/dehydrators.js';
import { ModelWithScope } from './mocks/models/ModelWithScope.js';
import { DateTime } from 'luxon';

chai.use(chaiAsPromised);
chai.use(chaiSubset);
const expect = chai.expect;
async function db() {
  return await DI.resolve(Orm);
}

describe('General model tests', () => {
  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    DI.register(FakeMysqlDriver).as('mysql');

    DI.register(FakeSelectQueryCompiler).as(SelectQueryCompiler);
    DI.register(FakeDeleteQueryCompiler).as(DeleteQueryCompiler);
    DI.register(FakeUpdateQueryCompiler).as(UpdateQueryCompiler);
    DI.register(FakeInsertQueryCompiler).as(InsertQueryCompiler);
    DI.register(FakeTableQueryCompiler).as(TableQueryCompiler);

    DI.register(DbPropertyHydrator).as(ModelHydrator);
    DI.register(NonDbPropertyHydrator).as(ModelHydrator);
    DI.register(FakeConverter).as(DatetimeValueConverter);
    DI.register(FakeServerResponseMapper).as(ServerResponseMapper);
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }
  });

  afterEach(async () => {
    DI.clearCache();
    sinon.restore();
  });

  it('Load models from dirs', async () => {
    const orm = await db();
    const models = await orm.Models;

    expect(models.length).to.eq(22);
  });

  it('Should set different connections to model', async () => {
    @Connection('test_model_conn_1')
    @Model('model_aa')
    class Model_AA extends ModelBase {}

    @Connection('test_model_conn_2')
    @Model('model_aa')
    class Model_BB extends ModelBase {}

    await db();

    const a = new Model_AA();
    const b = new Model_BB();

    expect(a.ModelDescriptor.Connection).to.eq('test_model_conn_1');
    expect(b.ModelDescriptor.Connection).to.eq('test_model_conn_2');
  });

  it('Models should have added mixins', async () => {
    expect(Model1.all).to.be.an('function');
    expect(Model1.destroy).to.be.an('function');
    expect(Model1.find).to.be.an('function');
    expect(Model1.findOrFail).to.be.an('function');
    expect(Model1.getOrFail).to.be.an('function');
    expect(Model1.getOrCreate).to.be.an('function');
    expect(Model1.getOrNew).to.be.an('function');
    expect(Model1.where).to.be.an('function');
  });

  it('Model should throw if no description', async () => {
    // @ts-ignore
    const orm = await db();

    expect(() => {
      ModelNoDescription.where('1', 1);
    }).to.throw('Not implemented');
  });

  it('Model should throw if invalid connection', async () => {
    // @ts-ignore
    const orm = await db();

    expect(() => {
      ModelNoConnection.where('1', 1);
    }).to.throw('model ModelNoConnection have invalid connection SampleConnectionNotExists, please check your db config file or model connection name');
  });

  it('Where mixin should work', async () => {
    // @ts-ignore
    const orm = await db();

    let query = Model1.where('Id', 1);
    expect(query instanceof SelectQueryBuilder).to.be.true;
    expect(query.Statements)
      .to.be.an('array')
      .with.length(1)
      .to.containSubset([
        {
          _column: 'Id',
          _operator: '=',
          _value: 1,
          _tableAlias: undefined,
        },
      ]);

    query = Model1.where('Id', '>', 1);
    expect(query instanceof SelectQueryBuilder).to.be.true;
    expect(query.Statements)
      .to.be.an('array')
      .with.length(1)
      .to.containSubset([
        {
          _column: 'Id',
          _operator: '>',
          _value: 1,
          _tableAlias: undefined,
        },
      ]);
  });

  it('All mixin should work', async () => {
    // @ts-ignore
    const orm = await db();

    const execute = sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([
          {
            a: 1,
          },
        ]);
      }),
    );

    const result = await Model1.all();
    expect(execute.calledOnce).to.be.true;
    expect(result).to.be.an('array').with.length(1);
    expect(result[0]).instanceOf(Model1);
  });

  it('Dehyration works', async () => {
    sinon.stub(FakeSqliteDriver.prototype, 'tableInfo').returns(
      new Promise((res) => {
        res([
          {
            Type: 'INT',
            MaxLength: 0,
            Comment: '',
            DefaultValue: null,
            NativeType: 'INT(10)',
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
            IsForeignKey: false,
            ForeignKeyDescription: null,
            Aggregate: false,
            Virtual: false,
          },
          {
            Type: 'INT',
            MaxLength: 0,
            Comment: '',
            DefaultValue: null,
            NativeType: 'INT(10)',
            Unsigned: false,
            Nullable: true,
            PrimaryKey: true,
            AutoIncrement: true,
            Name: 'OwnerId',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
            IsForeignKey: false,
            ForeignKeyDescription: null,
            Aggregate: false,
            Virtual: false,
          },
        ]);
      }),
    );

    const dehydrate = sinon.spy(StandardModelDehydrator.prototype, 'dehydrate');
    await db();

    const model = new Model1({
      Id: 1,
    });

    model.Owner.attach(new Model4({ Id: 10 }));

    const data = model.dehydrate();

    expect(data).to.be.not.null;
    expect(data.Id).to.eq(1);
    expect((data as any)['Owner']).to.be.undefined;
    expect(dehydrate.calledOnce).to.be.true;
  });

  it('Dehydration with relation works', async () => {
    sinon.stub(FakeSqliteDriver.prototype, 'tableInfo').returns(
      new Promise((res) => {
        res([
          {
            Type: 'INT',
            MaxLength: 0,
            Comment: '',
            DefaultValue: null,
            NativeType: 'INT(10)',
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
            IsForeignKey: false,
            ForeignKeyDescription: null,
            Aggregate: false,
            Virtual: false,
          },
          {
            Type: 'INT',
            MaxLength: 0,
            Comment: '',
            DefaultValue: null,
            NativeType: 'INT(10)',
            Unsigned: false,
            Nullable: true,
            PrimaryKey: true,
            AutoIncrement: true,
            Name: 'OwnerId',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
            IsForeignKey: false,
            ForeignKeyDescription: null,
            Aggregate: false,
            Virtual: false,
          },
        ]);
      }),
    );

    const dehydrate = sinon.spy(StandardModelWithRelationsDehydrator.prototype, 'dehydrate');
    await db();

    const model = new Model1({
      Id: 1,
    });

    model.Owner.attach(new Model4({ Id: 10 }));

    const data = model.dehydrateWithRelations();

    expect(data).to.be.not.null;
    expect(data.Id).to.eq(1);
    expect(data.Owner).to.be.not.null;
    expect(data.Owner.Id).to.eq(10);
    expect(dehydrate.calledTwice).to.be.true;
  });

  it('Converter should be executed when dehydrated', async () => {
    sinon.stub(FakeSqliteDriver.prototype, 'tableInfo').returns(
      new Promise((res) => {
        res([
          {
            Type: 'DATE',
            MaxLength: 0,
            Comment: '',
            DefaultValue: null,
            NativeType: 'INT(10)',
            Unsigned: false,
            Nullable: true,
            PrimaryKey: false,
            AutoIncrement: false,
            Name: 'ArchivedAt',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
            IsForeignKey: false,
            ForeignKeyDescription: null,
            Aggregate: false,
            Virtual: false,
          },
        ]);
      }),
    );

    sinon.stub(FakeInsertQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    await db();

    const toDb = sinon.spy(FakeConverter.prototype, 'toDB');

    const model = new Model1({
      ArchivedAt: DateTime.now(),
    });

    await model.insert();

    expect(toDb.called).to.be.true;
    expect(toDb.args[0]).to.be.not.null;
  });

  it('Converter should be executed when hydrated', async () => {
    sinon.stub(FakeSqliteDriver.prototype, 'tableInfo').returns(
      new Promise((res) => {
        res([
          {
            Type: 'DATE',
            MaxLength: 0,
            Comment: '',
            DefaultValue: null,
            NativeType: 'INT',
            Unsigned: false,
            Nullable: true,
            PrimaryKey: false,
            AutoIncrement: false,
            Name: 'ArchivedAt',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
            IsForeignKey: false,
            ForeignKeyDescription: null,
            Aggregate: false,
            Virtual: false,
          },
        ]);
      }),
    );

    sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([
          {
            Id: 1,
            ArchivedAt: new Date(),
            CreatedAt: new Date(),
          },
        ]);
      }),
    );

    await db();

    const fromDb = sinon.spy(FakeConverter.prototype, 'fromDB');

    await Model1.get(1);

    expect(fromDb.called).to.be.true;
    expect(fromDb.returnValues[0]).to.be.not.null;
  });

  it('Get should work', async () => {
    await db();

    const execute = sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([
          {
            a: 1,
          },
        ]);
      }),
    );

    const result = await Model1.get(1);

    expect(execute.calledOnce).to.be.true;
    expect(result).instanceof(Model1);
  });

  it('Find mixin should work', async () => {
    // @ts-ignore
    const orm = await db();
    const execute = sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([
          {
            a: 1,
          },
          {
            a: 1,
          },
        ]);
      }),
    );

    const result = await Model1.find([1, 2]);

    expect(execute.calledOnce).to.be.true;
    expect(result).to.be.an('array').with.length(2);
    expect(result[0]).instanceof(Model1);
  });

  it('FindOrFail mixin should work', async () => {
    // @ts-ignore
    const orm = await db();

    const execute = sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([
          {
            a: 1,
          },
        ]);
      }),
    );

    const result = await Model1.findOrFail([1]);

    expect(execute.calledOnce).to.be.true;
    expect(result).to.be.an('array').with.lengthOf(1);
    expect(result[0]).instanceof(Model1);
  });

  it('FindOrFail mixin should fail', async () => {
    // @ts-ignore
    const orm = await db();

    sinon.stub(FakeSelectQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([]);
      }),
    );

    expect(Model1.findOrFail([1])).to.be.rejected;
  });

  it('FirstOrThrow shouhld work', async () => {
    // @ts-ignore
    const orm = await db();

    const execute = sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([
          {
            a: 1,
          },
        ]);
      }),
    );

    const result = await Model1.where({ Id: 1 }).firstOrThrow(new Error('Not found'));

    expect(execute.calledOnce).to.be.true;
    expect(result).instanceof(Model1);
  });

  it('FirstOrThrow should throw', async () => {
    // @ts-ignore
    const orm = await db();

    sinon.stub(FakeSelectQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([]);
      }),
    );
    return expect(Model1.where({ Id: 1 }).firstOrThrow(new Error('Not found'))).to.be.rejectedWith(Error, 'Not found');
  });

  it('Should compare two models by primary key', async () => {
    await db();

    const model1 = new Model1({
      Id: 1,
    });

    const model2 = new Model1({
      Id: 1,
    });

    const model3 = new Model1({
      Id: 2,
    });

    expect(+model1 === +model2).to.be.true;
    expect(+model1 === +model3).to.be.false;
  });

  it('Should compare model by primary key  value', async () => {
    await db();

    const model1 = new Model1({
      Id: 1,
    });

    expect(+model1 === 1).to.be.true;
    expect(+model1 === 2).to.be.false;
  });

  it('destroy mixin should work', async () => {
    // @ts-ignore
    const orm = await db();

    sinon.stub(FakeDeleteQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    const execute = sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([]);
      }),
    );

    await RawModel.destroy(1);
    expect(execute.calledOnce).to.be.true;
  });

  it('model scope should work', async () => {
    // @ts-ignore
    const orm = await db();

    sinon.stub(FakeSelectQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    const execute = sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([]);
      }),
    );

    const scope = sinon.spy(ModelWithScopeQueryScope.prototype, 'whereIdIsGreaterThan');

    await ModelWithScope.query().whereIdIsGreaterThan(1);

    expect(execute.calledOnce).to.be.true;
    expect(scope.calledOnce).to.be.true;
  });

  it('update mixin should work', async () => {
    // @ts-ignore
    const orm = await db();

    sinon.stub(FakeUpdateQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    const execute = sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([]);
      }),
    );

    const query = RawModel.update({ Bar: 'hello' }).where('Id', 1);
    await query;

    expect(execute.calledOnce).to.be.true;
  });

  it('getOrCreate mixin should work', async () => {
    // @ts-ignore
    const orm = await db();

    sinon.stub(FakeInsertQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    sinon.stub(FakeSelectQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    const execute = sinon
      .stub(FakeSqliteDriver.prototype, 'execute')
      .onCall(0)
      .returns(
        new Promise((res) => {
          res([]);
        }),
      )
      .onCall(1)
      .returns(
        new Promise((res) => {
          res({ LastInsertId: 1, RowsAffected: 1 });
        }),
      );

    const result = await Model1.getOrCreate(1);
    expect(execute.calledTwice).to.be.true;
    expect(result).to.be.not.null;
    expect(result).instanceOf(Model1);
    expect(result.PrimaryKeyValue).to.eq(1);
  });

  it('getOrCreate should work with data', async () => {
    // @ts-ignore
    const orm = await db();

    sinon.stub(FakeInsertQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    sinon.stub(FakeSelectQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    const execute = sinon
      .stub(FakeSqliteDriver.prototype, 'execute')
      .onCall(0)
      .returns(
        new Promise((res) => {
          res([]);
        }),
      )
      .onCall(1)
      .returns(
        new Promise((res) => {
          res({ LastInsertId: 1, RowsAffected: 1 });
        }),
      );

    const result = await Model1.getOrCreate(1, { Bar: 'hello' });
    expect(execute.calledTwice).to.be.true;
    expect(result).to.be.not.null;
    expect(result).instanceOf(Model1);
    expect(result.PrimaryKeyValue).to.eq(1);
    expect(result.Bar).to.eq('hello');

    Model1.query().where({
      Bar: 'ss',
      Owner: 1,
    });
  });

  it('getOrNew with data should work', async () => {
    // @ts-ignore
    const orm = await db();

    sinon.stub(FakeSelectQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([]);
      }),
    );

    const result = await Model1.getOrNew({ Id: 666, Bar: 'hello' });
    expect(result).to.be.not.null;
    expect(result).instanceOf(Model1);
    expect(result.Bar).to.eq('hello');
  });

  it('getOrNew should work', async () => {
    // @ts-ignore
    const orm = await db();

    sinon.stub(FakeSelectQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    const execute = sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([]);
      }),
    );

    const result = await Model1.getOrNew({
      Id: 666,
    });
    expect(execute.calledOnce).to.be.true;
    expect(result).to.be.not.null;
    expect(result).instanceOf(Model1);
    expect(result.PrimaryKeyValue).to.be.null;
  });

  it('Model update should set updated_at', async () => {
    // @ts-ignore
    const orm = await db();

    sinon.stub(FakeUpdateQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([]);
      }),
    );

    const model = new Model1();
    model.PrimaryKeyValue = 1;

    await model.update();

    expect(model.UpdatedAt).to.be.not.null;
  });

  it('Model should create uuid', async () => {
    const tableInfoStub = sinon.stub(FakeSqliteDriver.prototype, 'tableInfo');
    tableInfoStub.withArgs('TestTable6', undefined).returns(
      new Promise((res) => {
        res([
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
            IsForeignKey: false,
            ForeignKeyDescription: null,
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
            Name: 'Property6',
            Converter: null,
            Schema: 'sqlite',
            Unique: true,
            Uuid: false,
            Ignore: false,
            IsForeignKey: false,
            ForeignKeyDescription: null,
            Aggregate: false,
            Virtual: false,
          },
        ]);
      }),
    );

    await db();

    const model = new Model6({
      Property6: 'test',
    });

    expect(model.Id).to.be.not.null;
  });

  it('Model should refresh', async () => {
    const tableInfoStub = sinon.stub(FakeSqliteDriver.prototype, 'tableInfo');

    tableInfoStub.withArgs('TestTable2', undefined).returns(
      new Promise((res) => {
        res([
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
            IsForeignKey: false,
            ForeignKeyDescription: null,
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
            Name: 'Bar',
            Converter: null,
            Schema: 'sqlite',
            Unique: true,
            Uuid: false,
            Ignore: false,
            IsForeignKey: false,
            ForeignKeyDescription: null,
            Aggregate: false,
            Virtual: false,
          },
        ]);
      }),
    );

    await db();

    sinon
      .stub(FakeSqliteDriver.prototype, 'execute')
      .onCall(0)
      .returns(
        new Promise((res) => {
          res({
            LastInsertId: 0,
            RowsAffected: 0,
          });
        }),
      )
      .onCall(1)
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 666,
            },
          ]);
        }),
      );

    sinon.stub(FakeInsertQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    const model = new RawModel({
      Bar: 'test',
    });

    await model.insert(InsertBehaviour.InsertOrIgnore);
    await model.refresh();

    expect(model.Id).to.eq(666);
  });

  it('Model delete should soft delete', async () => {
    // @ts-ignore
    const orm = await db();

    sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([]);
      }),
    );

    const model = new Model1();
    model.PrimaryKeyValue = 1;

    await model.destroy();
    expect(model.DeletedAt).to.be.not.null;
  });

  it('Orm should load column info for models', async () => {
    const tb = sinon.stub(FakeSqliteDriver.prototype, 'tableInfo').returns(
      new Promise((res) => {
        res([]);
      }),
    );

    // @ts-ignore
    const orm = await db();

    expect(tb.called).to.be.true;
  });

  it('Models should have proper properties', async () => {
    const orm = await db();
    const models = await orm.Models;

    let toCheck = models.find((x) => x.name === 'Model1');
    let descriptor = toCheck.type.getModelDescriptor() as IModelDescriptor;

    expect(descriptor).to.include({
      Connection: 'sqlite',
      TableName: 'TestTable1',
      PrimaryKey: 'Id',
      Name: 'Model1',
    });
    
    expect(descriptor.SoftDelete).to.deep.equal({
      DeletedAt: 'DeletedAt',
    });
    
    expect(descriptor.Archived).to.deep.equal({
      ArchivedAt: 'ArchivedAt',
    });
    
    expect(descriptor.Timestamps).to.deep.equal({
      CreatedAt: 'CreatedAt',
      UpdatedAt: 'UpdatedAt',
    });
    
    // Verify columns are loaded (should have Id, Bar, OwnerId from tableInfo)
    expect(descriptor.Columns).to.be.an('array');
    expect(descriptor.Columns.length).to.be.greaterThan(0);
    expect(descriptor.Columns.find((c) => c.Name === 'Id')).to.exist;

    toCheck = models.find((x) => x.name === 'Model2');
    descriptor = toCheck.type.getModelDescriptor() as IModelDescriptor;

    expect(descriptor).to.include({
      Connection: 'SampleConnection1',
      TableName: 'TestTable2',
      PrimaryKey: 'Id',
      Name: 'Model2',
    });
    
    expect(descriptor.SoftDelete).to.deep.equal({
      DeletedAt: 'DeletedAt',
    });
    
    expect(descriptor.Archived).to.deep.equal({
      ArchivedAt: 'ArchivedAt',
    });
    
    expect(descriptor.Timestamps).to.deep.equal({
      CreatedAt: 'CreatedAt',
      UpdatedAt: 'UpdatedAt',
    });
    
    // Verify columns are loaded (should have Id, Bar from tableInfo)
    expect(descriptor.Columns).to.be.an('array');
    expect(descriptor.Columns.length).to.be.greaterThan(0);
    expect(descriptor.Columns.find((c) => c.Name === 'Id')).to.exist;
  });

  it('Should register model programatically', async () => {
    @Connection('sqlite')
    @Model('TestTable1')
    // @ts-ignore
    class Test extends ModelBase {}

    class FakeOrm extends Orm {
      constructor() {
        super();

        this.registerModel(Test);
      }
    }

    const container = DI.child();
    container.register(ConnectionConf).as(Configuration);
    container.register(FakeSqliteDriver).as('sqlite');
    container.register(FakeOrm).as(Orm);

    const orm = await container.resolve(Orm);
    const models = await orm.Models;

    expect(models.find((m) => m.name === 'Test.registered')).to.be.not.null;
  });

  it('Custom middleware should work', async () => {
    sinon.stub(FakeSelectQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([
          {
            a: 1,
          },
        ]);
      }),
    );

    // @ts-ignore
    await db();
    const middleware = {
      // tslint:disable-next-line: no-empty
      afterQuery(data: any[]) {
        return data;
      },
      modelCreation(_: any): ModelBase {
        return null;
      },

      // tslint:disable-next-line: no-empty
      async afterHydration(_data: ModelBase[]) {},
    };
    const spy = sinon.spy(middleware, 'afterQuery');
    const spy2 = sinon.spy(middleware, 'afterHydration');
    const spy3 = sinon.spy(middleware, 'modelCreation');

    await Model1.where({ Id: 1 }).middleware(middleware);

    expect(spy.calledOnce).to.be.true;
    expect(spy2.calledOnce).to.be.true;
    expect(spy3.calledOnce).to.be.true;
  });
});

describe('Model discrimination tests', () => {
  beforeEach(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    DI.register(FakeMysqlDriver).as('mysql');

    DI.register(FakeSelectQueryCompiler).as(SelectQueryCompiler);
    DI.register(FakeDeleteQueryCompiler).as(DeleteQueryCompiler);
    DI.register(FakeUpdateQueryCompiler).as(UpdateQueryCompiler);
    DI.register(FakeInsertQueryCompiler).as(InsertQueryCompiler);
    DI.register(FakeTableQueryCompiler).as(TableQueryCompiler);

    DI.register(DbPropertyHydrator).as(ModelHydrator);
    DI.register(NonDbPropertyHydrator).as(ModelHydrator);
    DI.register(OneToOneRelationHydrator).as(ModelHydrator);
    DI.register(JunctionModelPropertyHydrator).as(ModelHydrator);
    DI.resolve<Orm>(Orm);

    const tableInfoStub = sinon.stub(FakeSqliteDriver.prototype, 'tableInfo');

    tableInfoStub.withArgs('Discrimination', undefined).returns(
      new Promise((res) => {
        res([
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
            IsForeignKey: false,
            ForeignKeyDescription: null,
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
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
            IsForeignKey: false,
            ForeignKeyDescription: null,
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
            Name: 'disck_key',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
            IsForeignKey: false,
            ForeignKeyDescription: null,
            Aggregate: false,
            Virtual: false,
          },
        ]);
      }),
    );
  });

  afterEach(async () => {
    DI.clearCache();
    sinon.restore();
  });

  it('should create models based on discrimination map', async () => {
    await db();

    sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([
          {
            Id: 1,
            disc_key: 'base',
          },
          {
            Id: 2,
            disc_key: 'two',
          },
          {
            Id: 3,
            disc_key: 'one',
          },
        ]);
      }),
    );

    const result = await ModelDiscBase.all();

    expect(result).to.be.not.null;
    expect(result[0]).instanceOf(ModelDiscBase);
    expect(result[1]).instanceOf(ModelDisc2);
    expect(result[2]).instanceOf(ModelDisc1);
  });
});

