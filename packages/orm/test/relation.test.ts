/* eslint-disable prettier/prettier */
import { ModelNested1 } from './mocks/models/ModelNested1';
import { RelationRecursive } from './mocks/models/RelationRecursive';
import { ManyToManyRelation, OneToManyRelationList, SingleRelation } from './../src/relations';
import { NonDbPropertyHydrator, DbPropertyHydrator, ModelHydrator, OneToOneRelationHydrator, JunctionModelPropertyHydrator } from './../src/hydrators';
import { Model1 } from './mocks/models/Model1';
import { MODEL_DESCTRIPTION_SYMBOL } from './../src/decorators';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import * as _ from 'lodash';
import 'mocha';
import { FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeInsertQueryCompiler, FakeUpdateQueryCompiler, ConnectionConf, FakeMysqlDriver, FakeTableQueryCompiler } from './misc';
import { SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, RelationType, TableQueryCompiler } from '../src/interfaces';
import * as sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import { extractModelDescriptor } from './../src/model';
import { RelationModel1 } from './mocks/models/RelationModel1';
import { BelongsToRelation, OneToManyRelation } from '../src/relations';
import { Orm } from '../src/orm';
import { RelationModel2 } from './mocks/models/RelationModel2';
import { Model4 } from './mocks/models/Model4';
import { ModelNested2 } from './mocks/models/ModelNested2';

const expect = chai.expect;
chai.use(chaiAsPromised);

async function db() {
  return await DI.resolve(Orm);
}

describe('Orm relations tests', () => {
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

    tableInfoStub.withArgs('TestTableRelation1', undefined).returns(
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
            Type: 'INT',
            MaxLength: 0,
            Comment: '',
            DefaultValue: null,
            NativeType: 'INT',
            Unsigned: false,
            Nullable: true,
            PrimaryKey: false,
            AutoIncrement: false,
            Name: 'OwnerId',
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
            Name: 'Property1',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
          },
        ]);
      }),
    );

    tableInfoStub.withArgs('TestTableRelation2', undefined).returns(
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
            Type: 'INT',
            MaxLength: 0,
            Comment: '',
            DefaultValue: null,
            NativeType: 'INT',
            Unsigned: false,
            Nullable: true,
            PrimaryKey: false,
            AutoIncrement: false,
            Name: 'OwnerId',
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
            Name: 'Property2',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
          },
        ]);
      }),
    );
    tableInfoStub.withArgs('TestTable1', undefined).returns(
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
            Name: 'RelId2',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
          },
        ]);
      }),
    );
    tableInfoStub.withArgs('JunctionTable', undefined).returns(
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
            Type: 'INT',
            MaxLength: 0,
            Comment: '',
            DefaultValue: null,
            NativeType: 'INT',
            Unsigned: false,
            Nullable: true,
            PrimaryKey: true,
            AutoIncrement: true,
            Name: 'model4_id',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
          },
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
            Name: 'model5_id',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
          },
        ]);
      }),
    );
    tableInfoStub.withArgs('ModelNested3', undefined).returns(
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
            Name: 'Property3',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
          },
        ]);
      }),
    );
    tableInfoStub.withArgs('ModelNested2', undefined).returns(
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
            Name: 'Property2',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
          },
        ]);
      }),
    );
    tableInfoStub.withArgs('ModelNested1', undefined).returns(
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
            Name: 'Property1',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
          },
        ]);
      }),
    );
    tableInfoStub.withArgs('TestTable5', undefined).returns(
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
            Name: 'Property5',
            Converter: null,
            Schema: 'sqlite',
            Unique: false,
            Uuid: false,
            Ignore: false,
          },
        ]);
      }),
    );

    tableInfoStub.withArgs('RelationRecursive', undefined).returns(
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
            Type: 'INT',
            MaxLength: 0,
            Comment: '',
            DefaultValue: null,
            NativeType: 'INT',
            Unsigned: false,
            Nullable: true,
            PrimaryKey: true,
            AutoIncrement: true,
            Name: 'parent_id',
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
    (Model1 as any)[MODEL_DESCTRIPTION_SYMBOL].Columns = [] as any;
  });

  it('Belongs to relation decorator', async () => {
    const descriptor = extractModelDescriptor(RelationModel1);

    expect(descriptor.Relations.size).to.eq(1);
    expect(descriptor.Relations.has('Owner')).to.be.true;

    expect(descriptor.Relations.get('Owner')).to.include({
      Name: 'Owner',
      Type: RelationType.One,
      PrimaryKey: 'Id',
      ForeignKey: 'OwnerId',
    });

    const desc = descriptor.Relations.get('Owner');

    expect(desc.TargetModel.name).to.eq('RelationModel2');
    expect(desc.SourceModel.name).to.eq('RelationModel1');
  });

  it('HasMany relation decorator', async () => {
    const descriptor = extractModelDescriptor(RelationModel2);

    expect(descriptor.Relations.size).to.eq(2);
    expect(descriptor.Relations.has('Many')).to.be.true;

    expect(descriptor.Relations.get('Many')).to.include({
      Name: 'Many',
      Type: RelationType.Many,
      PrimaryKey: 'Id',
      ForeignKey: 'RelId2',
    });

    const desc = descriptor.Relations.get('Many');

    expect(desc.TargetModel.name).to.eq('Model1');
    expect(desc.SourceModel.name).to.eq('RelationModel2');
  });

  it('HasManyToMany relation decorator', async () => {
    const descriptor = extractModelDescriptor(Model4);

    expect(descriptor.Relations.size).to.eq(1);
    expect(descriptor.Relations.has('ManyOwners')).to.be.true;

    expect(descriptor.Relations.get('ManyOwners')).to.include({
      Name: 'ManyOwners',
      Type: RelationType.ManyToMany,
      PrimaryKey: 'Id',
      ForeignKey: 'Id',
    });

    const desc = descriptor.Relations.get('ManyOwners');

    expect(desc.TargetModel.name).to.eq('Model5');
    expect(desc.SourceModel.name).to.eq('Model4');
    expect(desc.JunctionModel.name).to.eq('JunctionModel');
  });

  it('Belongs to relation is executed', async () => {
    await db();
    const callback = sinon.spy(BelongsToRelation.prototype, 'execute');

    const query = RelationModel1.where({ Id: 1 }).populate('Owner', function () {
      this.where('Property2', 'test');
    });

    expect(callback.calledOnce).to.be.true;
    expect(query).to.be.not.null;

    callback.restore();
  });

  it('Should return all relational models', async () => {
    const eStub = sinon
      .stub(FakeSqliteDriver.prototype, 'execute')
      .onCall(0)
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 1,
              Property1: 'Property1',
            },
          ]);
        }),
      )
      .onCall(1)
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 2,
              Property2: 'property2',
              rel_1: 1,
            },
          ]);
        }),
      )
      .onCall(2)
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 3,
              Property3: 'property3',
              rel_2: 2,
            },
          ]);
        }),
      )
      .onCall(3)
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 3,
              Property3: 'property3',
              rel_2: 2,
            },
          ]);
        }),
      );

    await db();

    const result = await ModelNested1.where({ Id: 1 })
      .populate('HasMany1', function () {
        this.populate('HasMany2');
      })
      .first();

    const models = result.getFlattenRelationModels();

    expect(models).to.be.an('array');
    eStub.restore();

  });

  it('HasMany nested relation is executed', async () => {
    const eStub = sinon
      .stub(FakeSqliteDriver.prototype, 'execute')
      .onCall(0)
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 1,
              Property1: 'Property1',
            },
          ]);
        }),
      )
      .onCall(1)
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 2,
              Property2: 'property2',
              rel_1: 1,
            },
          ]);
        }),
      )
      .onCall(2)
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 3,
              Property3: 'property3',
              rel_2: 2,
            },
          ]);
        }),
      )
      .onCall(3)
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 3,
              Property3: 'property3',
              rel_2: 2,
            },
          ]);
        }),
      );

    await db();
    const callback = sinon.spy(OneToManyRelation.prototype, 'execute');

    const result = await ModelNested1.where({ Id: 1 })
      .populate('HasMany1', function () {
        this.populate('HasMany2');
      })
      .first();
 
    expect(callback.calledTwice).to.be.true;
    expect(result).to.be.not.null;
    expect(result.HasMany1.length).to.eq(1);
    expect(result.HasMany1[0].HasMany2.length).to.eq(1);

    callback.restore();
    eStub.restore();
  });

  it('Belongs to nested relation is executed', async () => {
    await db();
    const callback = sinon.spy(BelongsToRelation.prototype, 'execute');

    const query = RelationModel1.where({ Id: 1 }).populate('Owner', function () {
      this.where('Property2', 'test');
      this.populate('Owner');
    });

    expect(callback.calledTwice).to.be.true;
    expect(query).to.be.not.null;

    callback.restore();
  });

  it('OneToOneRelationHydrator is working', async () => {
    await db();

    sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([
          {
            Id: 1,
            Property1: 'property1',
            OwnerId: 2,
            '$Owner$.Id': 2,
            '$Owner$.Property2': 'property2',
            '$Owner$.OwnerId': 3,
            '$Owner$.$Owner$.Id': 3,
            '$Owner$.$Owner$.Bar': 'bar',
          },
        ]);
      }),
    );

    const result = await RelationModel1.where({ Id: 1 })
      .populate('Owner', function () {
        this.populate('Owner');
      })
      .first();

    expect(result).to.be.not.null;
    expect(result.Owner).to.be.not.null;
    expect(result.Owner.Owner).to.be.not.null;

    expect(result.Owner instanceof SingleRelation).to.be.true;
    expect(result.Owner.Owner instanceof SingleRelation).to.be.true;
  });

  it('OneToOneRelation should be dehydrated', async () => {
    await db();

    sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([
          {
            Id: 1,
            Property1: 'property1',
            OwnerId: 2,
            '$Owner$.Id': 2,
            '$Owner$.Property2': 'property2',
            '$Owner$.OwnerId': 3,
            '$Owner$.$Owner$.Id': 3,
            '$Owner$.$Owner$.Bar': 'bar',
          },
        ]);
      }),
    );

    const result = await RelationModel1.where({ Id: 1 }).populate('Owner').first();
    const dehydrated = result.dehydrate() as any;

    expect(dehydrated).to.be.not.null;
    expect(dehydrated.OwnerId).to.eq(2);
  });

  it('BelongsTo recursive should work', async () => {
    await db();

    sinon
      .stub(FakeSqliteDriver.prototype, 'execute')
      .onFirstCall()
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 3,
              Value: 'Leaf',
              parent_id: 2,
            },
          ]);
        }),
      )
      .onSecondCall()
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 3,
              Value: 'Leaf',
              parent_id: 2,
            },
            {
              Id: 2,
              parent_id: 1,
              Value: 'Child1',
            },
            {
              Id: 1,
              Value: 'Root',
              parent_id: null,
            },
          ]);
        }),
      );

    const result = await RelationRecursive.where({ Id: 3 }).populate('Parent').first();

    expect(result).to.be.not.null;
    expect(result.Id).to.eq(3);
    expect(result.Parent.Id).to.eq(2);
    expect(result.Parent.Value).to.eq('Child1');
    expect(result.Parent.Parent.Id).to.eq(1);
    expect(result.Parent.Parent.Value).to.eq('Root');
  });

  it('populate should load missing relation data', async () => {
    await db();

    sinon
      .stub(FakeSqliteDriver.prototype, 'execute')
      .onFirstCall()
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 1,
              Property2: 'property2',
            },
          ]);
        }),
      )
      .onSecondCall()
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 1,
              Bar: 'property2',
            },
          ]);
        }),
      );

    const result = await RelationModel2.where({ Id: 1 }).first();

    expect(result.Many.length).to.eq(0);

    await result.Many.populate();

    expect(result.Many.length).to.be.gt(0);
    expect(result.Many[0]).instanceOf(Model1);
    expect(result.Many[0]).to.include({ Id: 1 });
  });

  it('HasMany relation should be executed', async () => {
    await db();

    sinon
      .stub(FakeSqliteDriver.prototype, 'execute')
      .onFirstCall()
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 1,
              Property2: 'property2',
            },
          ]);
        }),
      )
      .onSecondCall()
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 1,
              RelId2: 1,
            },
            {
              Id: 2,
              RelId2: 1,
            },
          ]);
        }),
      );

    const callback = sinon.spy(OneToManyRelation.prototype, 'execute');
    const query = RelationModel2.where({ Id: 1 }).populate('Many').first();

    expect(callback.calledOnce).to.be.true;
    expect(query).to.be.not.null;

    const result = await query;

    expect(result).to.be.not.null;
    expect(result.Many.length).to.eq(2);

    callback.restore();
  });

  it('HasMany relation with belongsToRelation should be executed', async () => {
    await db();

    sinon
      .stub(FakeSqliteDriver.prototype, 'execute')
      .onFirstCall()
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 1,
              Property2: 'property2',
            },
          ]);
        }),
      )
      .onSecondCall()
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 1,
              RelId2: 1,
              '$Owner$.Id': 2,
              '$Owner$.Property4': 'property1',
            },
            {
              Id: 2,
              RelId2: 1,
              '$Owner$.Id': 2,
              '$Owner$.Property4': 'property1',
            },
          ]);
        }),
      );

    const callback = sinon.spy(OneToManyRelation.prototype, 'execute');
    const query = RelationModel2.where({ Id: 1 })
      .populate('Many', function () {
        this.populate('Owner');
      })
      .first();

    const result = await query;

    expect(result.Many[0].Owner).to.be.not.null;
    expect(result.Many[1].Owner).to.be.not.null;

    callback.restore();
  });

  it('Setting Id for relation owner should set foreign key', () => {
    const m = new ModelNested1();
    const m2 = new ModelNested2();
    m.HasMany1.push(m2);
    m.PrimaryKeyValue = 666;

    expect((m2 as any)['rel_1']).to.eq(666);
  });

  it('Should attach model to relation and fill foreign key', () => {
    const m = new ModelNested1({
      Id: 777,
    });
    const m2 = new ModelNested2();

    m.attach(m2);

    expect((m2 as any)['rel_1']).to.eq(777);
    expect(m.HasMany1.length).to.eq(1);
  });

  it('HasManyToMany relation should be executed', async () => {
    await db();

    sinon
      .stub(FakeSqliteDriver.prototype, 'execute')
      .onFirstCall()
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 1,
              Property4: 'property4',
            },
          ]);
        }),
      )
      .onSecondCall()
      .returns(
        new Promise((res) => {
          res([
            {
              Id: 1,
              model4_id: 1,
              model5_id: 2,
              JoinProperty: 'joinProp1',
              '$ManyOwners$.Property5': 'prop5',
              '$ManyOwners$.Id': 2,
            },
            {
              Id: 2,
              model4_id: 1,
              model5_id: 3,
              JoinProperty: 'joinProp2',
              '$ManyOwners$.Property5': 'prop5',
              '$ManyOwners$.Id': 3,
            },
          ]);
        }),
      );

    const callback = sinon.spy(ManyToManyRelation.prototype, 'execute');
    const query = Model4.where({ Id: 1 }).populate('ManyOwners').first();

    expect(callback.calledOnce).to.be.true;
    expect(query).to.be.not.null;

    const result = await query;

    expect(result).to.be.not.null;
    expect(result.ManyOwners.length).to.eq(2);

    callback.restore();
  });

  it('should find diff', async () => {
    await db();

    const setA = new OneToManyRelationList(
      new Model1({ Id: 1 }),
      Model1,
      {
        TargetModel: Model1,
        Name: 'Translations',
        Type: RelationType.Many,
        SourceModel: null,
        ForeignKey: 'IdA',
        PrimaryKey: 'Id',
        Recursive: false,
      },
      [new Model1({ Id: 1 }), new Model1({ Id: 2 })],
    );
    const setB = new OneToManyRelationList(
      new Model1({ Id: 1 }),
      Model1,
      {
        TargetModel: Model1,
        Name: 'Translations',
        Type: RelationType.Many,
        SourceModel: null,
        ForeignKey: 'IdA',
        PrimaryKey: 'Id',
        Recursive: false,
      },
      [new Model1({ Id: 1 }), new Model1({ Id: 3 }), new Model1({ Id: 4 })],
    );

    await setA.diff(setB);
    expect(setA.length).to.eq(1);
    expect(setA[0].Id).to.eq(2);
  });

  it('should set', async () => {
    await db();

    const setA = new OneToManyRelationList(
      new Model1({ Id: 1 }),
      Model1,
      {
        TargetModel: Model1,
        Name: 'Translations',
        Type: RelationType.Many,
        SourceModel: null,
        ForeignKey: 'IdA',
        PrimaryKey: 'Id',
        Recursive: false,
      },
      [new Model1({ Id: 1 }), new Model1({ Id: 2 })],
    );
    const setB = new OneToManyRelationList(
      new Model1({ Id: 1 }),
      Model1,
      {
        TargetModel: Model1,
        Name: 'Translations',
        Type: RelationType.Many,
        SourceModel: null,
        ForeignKey: 'IdA',
        PrimaryKey: 'Id',
        Recursive: false,
      },
      [new Model1({ Id: 1 }), new Model1({ Id: 3 }), new Model1({ Id: 4 })],
    );

    await setA.set(setB);
    expect(setA.length).to.eq(3);
    expect(setA[0].Id).to.eq(1);
    expect(setA[1].Id).to.eq(3);
    expect(setA[2].Id).to.eq(4);
  });

  it('should find intersection', async () => {
    await db();

    const setA = new OneToManyRelationList(
      new Model1({ Id: 1 }),
      Model1,
      {
        TargetModel: Model1,
        Name: 'Translations',
        Type: RelationType.Many,
        SourceModel: null,
        ForeignKey: 'IdA',
        PrimaryKey: 'Id',
        Recursive: false,
      },
      [new Model1({ Id: 1 }), new Model1({ Id: 2 })],
    );
    const setB = new OneToManyRelationList(
      new Model1({ Id: 1 }),
      Model1,
      {
        TargetModel: Model1,
        Name: 'Translations',
        Type: RelationType.Many,
        SourceModel: null,
        ForeignKey: 'IdA',
        PrimaryKey: 'Id',
        Recursive: false,
      },
      [new Model1({ Id: 1 }), new Model1({ Id: 3 })],
    );

    await setA.intersection(setB);
    expect(setA.length).to.eq(1);
    expect(setA[0].Id).to.eq(1);
  });
});
