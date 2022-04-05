/* eslint-disable prettier/prettier */
import { NonDbPropertyHydrator, DbPropertyHydrator, ModelHydrator, OneToOneRelationHydrator, JunctionModelPropertyHydrator } from './../src/hydrators';
import { ModelNoConnection } from './mocks/models/ModelNoConnection';
import { ModelNoDescription } from './mocks/models/ModelNoDescription';
import { SelectQueryBuilder } from './../src/builders';
import { Model1 } from './mocks/models/Model1';
import { MODEL_DESCTRIPTION_SYMBOL } from './../src/decorators';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import * as _ from 'lodash';
import 'mocha';
import { Orm } from '../src/orm';
import { FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeInsertQueryCompiler, FakeUpdateQueryCompiler, ConnectionConf, FakeMysqlDriver, FakeConverter, FakeTableQueryCompiler } from './misc';
import { IModelDescrtiptor, SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, InsertBehaviour, DatetimeValueConverter, TableQueryCompiler } from '../src/interfaces';
import * as sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import chaiSubset from 'chai-subset';
import { RawModel } from './mocks/models/RawModel';
import { Model, Connection } from '../src/decorators';
import { ModelBase } from './../src/model';
import { Model3 } from './mocks/models/Model3';
import { ModelDiscBase } from './mocks/models/ModelDiscBase';
import { ModelDisc1 } from './mocks/models/ModelDisc1';
import { ModelDisc2 } from './mocks/models/ModelDisc2';
import { Model6 } from './mocks/models/Model6';

const expect = chai.expect;
chai.use(chaiAsPromised);
chai.use(chaiSubset);

async function db() {
  return await DI.resolve(Orm);
}

describe('General model tests', () => {
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
    DI.register(FakeConverter).as(DatetimeValueConverter);
  });

  afterEach(async () => {
    DI.clearCache();

    sinon.restore();
    (Model1 as any)[MODEL_DESCTRIPTION_SYMBOL].Columns = [] as any;
  });

  it('Load models from dirs', async () => {
    const orm = await db();
    const models = await orm.Models;

    expect(models.length).to.eq(19);
    expect(models[1].name).to.eq('Model1');
    expect(models[2].name).to.eq('Model2');
    expect(models[1].type.name).to.eq('Model1');
    expect(models[2].type.name).to.eq('Model2');
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
    }).to.throw('model ModelNoDescription does not have model descriptor. Use @model decorator on class');
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

    let query = Model1.where('id', 1);
    expect(query instanceof SelectQueryBuilder).to.be.true;
    expect(query.Statements)
      .to.be.an('array')
      .with.length(1)
      .to.containSubset([
        {
          _column: 'id',
          _operator: '=',
          _value: 1,
          _tableAlias: undefined,
        },
      ]);

    query = Model1.where('id', '>', 1);
    expect(query instanceof SelectQueryBuilder).to.be.true;
    expect(query.Statements)
      .to.be.an('array')
      .with.length(1)
      .to.containSubset([
        {
          _column: 'id',
          _operator: '>',
          _value: 1,
          _tableAlias: undefined,
        },
      ]);
  });

  it('All mixin should work', async () => {
    // @ts-ignore
    const orm = await db();

    const compile = sinon.stub(FakeSelectQueryCompiler.prototype, 'compile').returns({
      expression: 'SELECT * FROM model1',
      bindings: [],
    });

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

    expect(compile.calledOnce).to.be.true;
    expect(execute.calledOnceWith('SELECT * FROM model1', [])).to.be.true;
    expect(result).to.be.an('array').with.length(1);
    expect(result[0]).instanceOf(Model1);
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
            NativeType: 'INT',
            Unsigned: false,
            Nullable: true,
            PrimaryKey: true,
            AutoIncrement: true,
            Name: 'ArchivedAt',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
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
      ArchivedAt: new Date(),
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
            PrimaryKey: true,
            AutoIncrement: true,
            Name: 'ArchivedAt',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
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

    const compile = sinon.stub(FakeSelectQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

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

    expect(compile.calledOnce).to.be.true;
    expect(execute.calledOnce).to.be.true;
    expect(result).instanceof(Model1);
  });

  it('Find mixin should work', async () => {
    // @ts-ignore
    const orm = await db();

    const compile = sinon.stub(FakeSelectQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

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

    expect(compile.calledOnce).to.be.true;
    expect(execute.calledOnce).to.be.true;
    expect(result).to.be.an('array').with.length(2);
    expect(result[0]).instanceof(Model1);
  });

  it('FindOrFail mixin should work', async () => {
    // @ts-ignore
    const orm = await db();

    const compile = sinon.stub(FakeSelectQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

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

    expect(compile.calledOnce).to.be.true;
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

    const result = await Model1.getOrNew(666, { Bar: 'hello' });
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

    const result = await Model1.getOrNew(1);
    expect(execute.calledOnce).to.be.true;
    expect(result).to.be.not.null;
    expect(result).instanceOf(Model1);
    expect(result.PrimaryKeyValue).to.be.undefined;
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

  it('Model should insert', async () => {
    // @ts-ignore
    const orm = await db();

    const fI = sinon.stub(FakeInsertQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    sinon
      .stub(FakeSqliteDriver.prototype, 'execute')
      .onCall(0)
      .returns(
        new Promise((res) => {
          res([{ Id: 1 }]);
        }),
      );

    await Model1.insert({
      Bar: 'hello',
    });

    expect(fI.calledOnce).to.be.true;
  });

  it('Model should insert array at one query', async () => {
    // @ts-ignore
    const orm = await db();

    const fI = sinon.stub(FakeInsertQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    sinon
      .stub(FakeSqliteDriver.prototype, 'execute')
      .onCall(0)
      .returns(
        new Promise((res) => {
          res([{ Id: 1 }]);
        }),
      );

    await Model1.insert([{ Bar: 'hello' }, { Bar: 'hello' }, { Bar: 'hello' }]);

    expect(fI.calledOnce).to.be.true;
  });

  it('destroy should update deleted_at', async () => {
    // @ts-ignore
    const orm = await db();

    const df = sinon.stub(FakeDeleteQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    const uf = sinon.stub(FakeUpdateQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    sinon
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
          res([{ Id: 1 }]);
        }),
      )
      .onCall(2)
      .returns(
        new Promise((res) => {
          res([1]);
        }),
      );

    await Model1.destroy(1);

    expect(df.calledOnce).to.be.false;
    expect(uf.calledOnce).to.be.true;
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

  it('Model delete should delete if no soft delete', async () => {
    // @ts-ignore
    const orm = await db();

    const del = sinon.stub(FakeDeleteQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([]);
      }),
    );

    const model = new RawModel();
    model.PrimaryKeyValue = 1;

    await model.destroy();

    expect(del.calledOnce).to.be.true;
  });

  it('Model delete should soft delete', async () => {
    // @ts-ignore
    const orm = await db();

    const del = sinon.stub(FakeDeleteQueryCompiler.prototype, 'compile').returns({
      expression: '',
      bindings: [],
    });

    const up = sinon.stub(FakeUpdateQueryCompiler.prototype, 'compile').returns({
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

    await model.destroy();

    expect(del.calledOnce).to.be.false;
    expect(up.calledOnce).to.be.true;
    expect(model.DeletedAt).to.be.not.null;
  });

  it('hydrate should set non db properties', async () => {
    const test = new Model3();
    test.Id = 1;
    test.Foo.set('bar', 'baz');

    const newMap = new Map<string, string>();
    newMap.set('zar', 'far');

    const test2 = new Model3({ ...test, Foo: new Map([...test.Foo, ...newMap]) });

    expect(test2.Id).to.eq(1);
    expect(test2.Foo.size).to.eq(2);
    expect(test2.Foo.has('bar')).to.be.true;
    expect(test2.Foo.has('zar')).to.be.true;
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

    let toCheck = models[1];
    let descriptor = toCheck.type[MODEL_DESCTRIPTION_SYMBOL] as IModelDescrtiptor;

    expect(descriptor).to.deep.include({
      Connection: 'sqlite',
      TableName: 'TestTable1',
      SoftDelete: {
        DeletedAt: 'DeletedAt',
      },
      Archived: {
        ArchivedAt: 'ArchivedAt',
      },
      Columns: [],
      Timestamps: {
        CreatedAt: 'CreatedAt',
        UpdatedAt: 'UpdatedAt',
      },
      PrimaryKey: 'Id',
      Name: 'Model1',
    });

    toCheck = models[2];
    descriptor = toCheck.type[MODEL_DESCTRIPTION_SYMBOL] as IModelDescrtiptor;

    expect(descriptor).to.deep.include({
      Connection: 'SampleConnection1',
      TableName: 'TestTable2',
      SoftDelete: {
        DeletedAt: 'DeletedAt',
      },
      Archived: {
        ArchivedAt: 'ArchivedAt',
      },
      Columns: [],
      Timestamps: {
        CreatedAt: 'CreatedAt',
        UpdatedAt: 'UpdatedAt',
      },
      PrimaryKey: 'Id',
      Name: 'Model2',
    });
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
          },
        ]);
      }),
    );
  });

  afterEach(async () => {
    DI.clearCache();
    sinon.restore();
  });

  it('should create models base on discrimination map', async () => {
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
