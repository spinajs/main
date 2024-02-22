/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable prettier/prettier */
import { expect } from 'chai';
import 'mocha';
import { SelectQueryBuilder, SchemaQueryBuilder, DeleteQueryBuilder, InsertQueryBuilder, RawQuery, TableQueryBuilder, Orm, IWhereBuilder, Wrapper, IndexQueryBuilder, ReferentialAction, ICompilerOutput, ISelectQueryBuilder, ModelBase } from '@spinajs/orm';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';
import { RelationModel } from './Models/RelationModel.js';
import * as sinon from 'sinon';
import { RelationModel3 } from './Models/RelationModel3.js';
import { DateTime } from 'luxon';
import { RelationModel2 } from './Models/RelationModel2.js';

function sqb() {
  const connection = db().Connections.get('sqlite');
  return connection.Container.resolve(SelectQueryBuilder, [connection]);
}

function dqb() {
  const connection = db().Connections.get('sqlite');
  return connection.Container.resolve(DeleteQueryBuilder, [connection]);
}

function iqb() {
  const connection = db().Connections.get('sqlite');
  return connection.Container.resolve(InsertQueryBuilder, [connection]);
}

function schqb() {
  const connection = db().Connections.get('sqlite');
  return connection.Container.resolve(SchemaQueryBuilder, [connection]);
}

function inqb() {
  const connection = db().Connections.get('sqlite');
  return connection.Container.resolve(IndexQueryBuilder, [connection]);
}

function db() {
  return DI.get(Orm);
}

describe('Query builder generic', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('clear columns', () => {
    const result = sqb().select('a').select('b').from('users').clearColumns().toDB();
    expect(result.expression).to.equal('SELECT * FROM `users`');
  });

  it('throw on invalid table', () => {
    expect(() => {
      sqb().select('*').from('');
    }).to.throw;

    expect(() => {
      sqb().select('*').from('  ');
    }).to.throw;
  });

  it('set & get schema', () => {
    const query = sqb().select('*').from('users').database('spine');

    expect(query.Database).to.equal('spine');
    expect(query.toDB().expression).to.equal('SELECT * FROM `spine`.`users`');
  });

  it('set & get alias', () => {
    const query = sqb().select('*').from('users', 'u');

    expect(query.TableAlias).to.equal('u');
    expect(query.toDB().expression).to.equal('SELECT `u`.* FROM `users` as `u`');
  });

  it('ensure table presents', () => {
    const table = '';

    expect(() => {
      sqb().select('*').from(table).toDB();
    }).to.throw();

    expect(() => {
      sqb().select('*').from(null).toDB();
    }).to.throw();
  });

  it('ensure schema presents', () => {
    const schema = '';

    expect(() => {
      sqb().select('*').from('users').database(schema).toDB();
    }).to.throw();

    expect(() => {
      sqb().select('*').from('users').database(null).toDB();
    }).to.throw();
  });
});

describe('Where query builder', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('left join', () => {
    const result = sqb().select('*').from('users').leftJoin('adresses', 'addressId', 'id').toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` LEFT JOIN `adresses` ON id = addressId');
  });

  it('right join', () => {
    const result = sqb().select('*').from('users').rightJoin('adresses', 'addressId', 'id').toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` RIGHT JOIN `adresses` ON id = addressId');
  });

  it('left outer join', () => {
    const result = sqb().select('*').from('users').leftOuterJoin('adresses', 'addressId', 'id').toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` LEFT OUTER JOIN `adresses` ON id = addressId');
  });

  it('inner join', () => {
    const result = sqb().select('*').from('users').innerJoin('adresses', 'addressId', 'id').toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` INNER JOIN `adresses` ON id = addressId');
  });

  it('right outer join', () => {
    const result = sqb().select('*').from('users').rightOuterJoin('adresses', 'addressId', 'id').toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` RIGHT OUTER JOIN `adresses` ON id = addressId');
  });

  it('full outer join', () => {
    const result = sqb().select('*').from('users').fullOuterJoin('adresses', 'addressId', 'id').toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` FULL OUTER JOIN `adresses` ON id = addressId');
  });

  it('cross join', () => {
    const result = sqb().select('*').from('users').crossJoin('adresses', 'addressId', 'id').toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` CROSS JOIN `adresses` ON id = addressId');
  });

  it('multiple joins', () => {
    const result = sqb().select('*').from('users').leftJoin('adresses', 'addressId', 'id').leftJoin('account', 'accountId', 'id').toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` LEFT JOIN `adresses` ON id = addressId LEFT JOIN `account` ON id = accountId');
  });

  it('raw query joins', () => {
    const result = sqb().select('*').from('users').leftJoin(new RawQuery('client ON foo=bar')).toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` LEFT JOIN client ON foo=bar');
  });

  it('clear where', () => {
    const result = sqb().select('*').from('users').where('id', '=', 1).clearWhere().toDB();
    expect(result.expression).to.equal('SELECT * FROM `users`');
  });

  it('where rlike', () => {
    const result = sqb().select('*').from('users').where('Name', 'rlike', '.*').toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` WHERE `Name` RLIKE ?');
  });

  it('where exists', () => {
    const result = sqb().select('*').from('users').whereExist(sqb().where('id', 1).from('comments') as ISelectQueryBuilder<ModelBase<unknown>>).toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` WHERE EXISTS ( SELECT * FROM `comments` WHERE `id` = ? )');
  });

  it('where not exists', () => {
    const result = sqb().select('*').from('users').whereNotExists(sqb().where('id', 1).from('comments') as ISelectQueryBuilder<ModelBase<unknown>>).toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` WHERE NOT EXISTS ( SELECT * FROM `comments` WHERE `id` = ? )');
  });

  it('where in', () => {
    const result = sqb().select('*').from('users').whereIn('id', [1, 2, 3]).toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` WHERE `id` IN (?,?,?)');
    expect(result.bindings).to.be.an('array').to.include.members([1, 2, 3]);
  });

  it('where not in', () => {
    const result = sqb().select('*').from('users').whereNotIn('id', [1, 2, 3]).toDB();
    expect(result.expression).to.eq('SELECT * FROM `users` WHERE `id` NOT IN (?,?,?)');
    expect(result.bindings).to.be.an('array').to.include.members([1, 2, 3]);
  });

  it('where between', () => {
    const result = sqb().select('*').from('users').whereBetween('id', [1, 2]).toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` WHERE `id` BETWEEN ? AND ?');
    expect(result.bindings).to.be.an('array').to.include.members([1, 2]);
  });

  it('where not between', () => {
    const result = sqb().select('*').from('users').whereNotBetween('id', [1, 2]).toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` WHERE `id` NOT BETWEEN ? AND ?');
    expect(result.bindings).to.be.an('array').to.include.members([1, 2]);
  });

  it('where simple and', () => {
    const result = sqb().select('*').from('users').where('id', 1).where('email', 'spine@spine.pl').toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` WHERE `id` = ? AND `email` = ?');
    expect(result.bindings).to.be.an('array').to.include('spine@spine.pl');
  });

  it('where simple or', () => {
    const result = sqb().select('*').from('users').where('id', 1).orWhere('email', 'spine@spine.pl').toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` WHERE `id` = ? OR `email` = ?');
    expect(result.bindings).to.be.an('array').to.include.members([1, 'spine@spine.pl']);
  });

  it('where nested expressions', () => {
    const result = sqb().select('*').from('users').where('id', 1).orWhere('email', 'spine@spine.pl').toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` WHERE `id` = ? OR `email` = ?');
  });

  it('where true && where false', () => {
    let result = sqb().select('*').from('users').where(true).toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` WHERE TRUE');

    result = sqb().select('*').from('users').where(false).toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` WHERE FALSE');
  });

  it('Should convert date to sql', () => {
    let result = sqb().select('*').from('users').where('CreatedAt', new Date('2022-07-21T09:35:31.820Z')).toDB();

    expect(result.expression).to.equal('SELECT * FROM `users` WHERE `CreatedAt` = ?');
    expect(result.bindings[0]).to.equal('2022-07-21 11:35:31.820');

    result = sqb().select('*').from('users').where('CreatedAt', DateTime.fromISO('2022-07-21T09:35:31.820Z')).toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` WHERE `CreatedAt` = ?');
    expect(result.bindings[0]).to.equal('2022-07-21 11:35:31.820');
  });

  it('Should resolve datetime in where as object', () => {
    let result = sqb()
      .select('*')
      .from('users')
      .where({
        CreatedAt: new Date('2022-07-21 11:35:31.820 +02:00'),
      })
      .toDB();

    expect(result.expression).to.equal('SELECT * FROM `users` WHERE `CreatedAt` = ?');
    expect(result.bindings[0]).to.equal('2022-07-21 11:35:31.820');

    result = sqb()
      .select('*')
      .from('users')
      .where({
        CreatedAt: DateTime.fromISO('2022-07-21T09:35:31.820Z'),
      })
      .toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` WHERE `CreatedAt` = ?');
    expect(result.bindings[0]).to.equal('2022-07-21 11:35:31.820');
  });

  it('where with nested expressions', () => {
    const result = sqb()
      .select('*')
      .from('users')
      .where(function () {
        this.where('a', 1).where('b', 2);
      })
      .orWhere(function () {
        this.where('c', 1).where('d', 2);
      })
      .orWhere('f', 3)
      .toDB();

    expect(result.expression).to.equal('SELECT * FROM `users` WHERE ( `a` = ? AND `b` = ? ) OR ( `c` = ? AND `d` = ? ) OR `f` = ?');
  });

  it('where RAW expressions', () => {
    const result = sqb().select('*').from('users').where(RawQuery.create('foo = bar AND zar.id = tar.id')).toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` WHERE foo = bar AND zar.id = tar.id');
  });

  it('where explicit operator', () => {
    const result = sqb().select('*').from('users').where('id', '>=', 1).toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` WHERE `id` >= ?');

    expect(() => {
      sqb().select('*').from('users').where('id', '>==', 1).toDB();
    }).to.throw();
  });

  it('where object with datetime', () => {
    const result = sqb()
      .select('*')
      .from('users')
      .where({
        created_at: DateTime.fromFormat('29/01/2023', 'dd/MM/yyyy'),
      })
      .toDB();

    expect(result.expression).to.equal('SELECT * FROM `users` WHERE `created_at` = ?');
    expect(result.bindings).to.be.an('array').to.include('2023-01-29 00:00:00.000');
  });

  it('where object should filter out undefined vals and empty arrays', () => {
    const result = sqb()
      .select('*')
      .from('users')
      .where({
        id: undefined,
        active: [],
      })
      .toDB();

    expect(result.expression).to.equal('SELECT * FROM `users`');
  });

  it('where object with arrays', () => {
    const result = sqb()
      .select('*')
      .from('users')
      .where({
        id: [1],
        active: [true],
      })
      .toDB();

    expect(result.expression).to.equal('SELECT * FROM `users` WHERE `id` IN (?) AND `active` IN (?)');
  });

  it('where object as argument', () => {
    const result = sqb()
      .select('*')
      .from('users')
      .where({
        id: 1,
        active: true,
      })
      .toDB();

    expect(result.expression).to.equal('SELECT * FROM `users` WHERE `id` = ? AND `active` = ?');
    expect(result.bindings).to.be.an('array').to.include(1).and.include(true);
  });

  it('where throws if value is undefined', () => {
    expect(() => {
      sqb().select('*').from('users').where('id', undefined).toDB();
    }).to.throw;
  });
});

describe('Delete query builder', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');

    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('Simple delete', () => {
    const result = dqb().from('users').database('spine').where('active', false).toDB();
    expect(result.expression).to.equal('DELETE FROM `spine`.`users` WHERE `active` = ?');
  });

  it('Should delete with datetime', () => {
    const result = dqb().from('users').database('spine').where('CreatedAt', DateTime.fromISO('2022-07-21T09:35:31.820Z')).toDB();
    expect(result.expression).to.equal('DELETE FROM `spine`.`users` WHERE `CreatedAt` = ?');
    expect(result.bindings[0]).to.equal('2022-07-21 11:35:31.820');
  });

  it('Simple truncate', () => {
    const result = db().Connections.get('sqlite').truncate('users').database('spine').toDB();
    expect(result.expression).to.equal('TRUNCATE TABLE `spine`.`users`');
  });
});

describe('Relations query builder', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');

    const tableInfoStub = sinon.stub(FakeSqliteDriver.prototype, 'tableInfo');
    tableInfoStub
      .withArgs('RelationTable', undefined)
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
              Name: 'Id',
              Converter: null,
              Schema: 'sqlite',
              Unique: false,
              Uuid: false,
              Ignore: false,
              IsForeignKey: false,
              ForeignKeyDescription: null,
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
              Name: 'relation_id',
              Converter: null,
              Schema: 'sqlite',
              Unique: false,
              Uuid: false,
              Ignore: false,
              IsForeignKey: false,
              ForeignKeyDescription: null,
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
              Name: 'relation2_id',
              Converter: null,
              Schema: 'sqlite',
              Unique: false,
              Uuid: false,
              Ignore: false,
              IsForeignKey: false,
              ForeignKeyDescription: null,
            },
          ]);
        }),
      )
      .withArgs('RelationTable2', undefined)
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
              Name: 'Id',
              Converter: null,
              Schema: 'sqlite',
              Unique: false,
              Uuid: false,
              Ignore: false,
              IsForeignKey: false,
              ForeignKeyDescription: null,
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
              Name: 'RelationProperty',
              Converter: null,
              Schema: 'sqlite',
              Unique: false,
              Uuid: false,
              Ignore: false,
              IsForeignKey: false,
              ForeignKeyDescription: null,
            },
          ]);
        }),
      )
      .withArgs('RelationTable3', undefined)
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
              Name: 'Id',
              Converter: null,
              Schema: 'sqlite',
              Unique: false,
              Uuid: false,
              Ignore: false,
              IsForeignKey: false,
              ForeignKeyDescription: null,
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
              Name: 'RelationProperty3',
              Converter: null,
              Schema: 'sqlite',
              Unique: false,
              Uuid: false,
              Ignore: false,
              IsForeignKey: false,
              ForeignKeyDescription: null,
            },
          ]);
        }),
      )
      .withArgs('JoinTable', undefined)
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
              Name: 'Id',
              Converter: null,
              Schema: 'sqlite',
              Unique: false,
              Uuid: false,
              Ignore: false,
              IsForeignKey: false,
              ForeignKeyDescription: null,
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
              Name: 'owner_id',
              Converter: null,
              Schema: 'sqlite',
              Unique: false,
              Uuid: false,
              Ignore: false,
              IsForeignKey: false,
              ForeignKeyDescription: null,
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
              Name: 'target_id',
              Converter: null,
              Schema: 'sqlite',
              Unique: false,
              Uuid: false,
              Ignore: false,
              IsForeignKey: false,
              ForeignKeyDescription: null,
            },
          ]);
        }),
      )
      .withArgs('RelationTable4', undefined)
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
              Name: 'Id',
              Converter: null,
              Schema: 'sqlite',
              Unique: false,
              Uuid: false,
              Ignore: false,
              IsForeignKey: false,
              ForeignKeyDescription: null,
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
              Name: 'Model4Property',
              Converter: null,
              Schema: 'sqlite',
              Unique: false,
              Uuid: false,
              Ignore: false,
              IsForeignKey: false,
              ForeignKeyDescription: null,
            },
          ]);
        }),
      );

    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
    sinon.restore();
  });

  it('should query by relation in where', () => {
    const result = RelationModel.where({ Relation: 1 }).toDB() as ICompilerOutput;
    expect(result.expression).to.equal('SELECT * FROM `RelationTable` WHERE `relation_id` = ?');
    expect(result.bindings[0]).to.equal(1);

    const result2 = RelationModel.where({ Relation: new RelationModel2({ Id: 2 }) }).toDB() as ICompilerOutput;
    expect(result2.expression).to.equal('SELECT * FROM `RelationTable` WHERE `relation_id` = ?');
    expect(result2.bindings[0]).to.equal(2);

    const result3 = RelationModel.where('Relation', 1).toDB() as ICompilerOutput;
    expect(result3.expression).to.equal('SELECT * FROM `RelationTable` WHERE `relation_id` = ?');
    expect(result3.bindings[0]).to.equal(1);

    const result4 = RelationModel.where('Relation', new RelationModel2({ Id: 2 })).toDB() as ICompilerOutput;
    expect(result4.expression).to.equal('SELECT * FROM `RelationTable` WHERE `relation_id` = ?');
    expect(result4.bindings[0]).to.equal(2);
  });

  it('belongsTo simple', () => {
    const result = RelationModel.where('Id', 1).populate('Relation').toDB() as ICompilerOutput;

    expect(result.expression).to.equal('SELECT `$RelationModel$`.*,`$Relation$`.`Id` as `$Relation$.Id`,`$Relation$`.`RelationProperty` as `$Relation$.RelationProperty` FROM `RelationTable` as `$RelationModel$` LEFT JOIN `RelationTable2` as `$Relation$` ON `$RelationModel$`.relation_id = `$Relation$`.Id WHERE `$RelationModel$`.`Id` = ?');
  });

  it('belongsTo nested', () => {
    const result = RelationModel.where('Id', 1)
      .populate('Relation', function () {
        this.populate('Relation3');
      })
      .toDB() as ICompilerOutput;

    expect(result.expression).to.equal('SELECT `$RelationModel$`.*,`$Relation$`.`Id` as `$Relation$.Id`,`$Relation$`.`RelationProperty` as `$Relation$.RelationProperty`,`$Relation$.$Relation3$`.`Id` as `$Relation$.$Relation3$.Id`,`$Relation$.$Relation3$`.`RelationProperty` as `$Relation$.$Relation3$.RelationProperty` FROM `RelationTable` as `$RelationModel$` LEFT JOIN `RelationTable2` as `$Relation$` ON `$RelationModel$`.relation_id = `$Relation$`.Id LEFT JOIN `RelationTable2` as `$Relation$.$Relation3$` ON `$Relation$`.relation3_id = `$Relation$.$Relation3$`.Id WHERE `$RelationModel$`.`Id` = ?');
  });

  it('belongsTo with custom keys', () => {
    const result = RelationModel.where('Id', 1).populate('Relation2').toDB() as ICompilerOutput;
    expect(result.expression).to.equal('SELECT `$RelationModel$`.*,`$Relation2$`.`Id` as `$Relation2$.Id`,`$Relation2$`.`RelationProperty` as `$Relation2$.RelationProperty` FROM `RelationTable` as `$RelationModel$` LEFT JOIN `RelationTable2` as `$Relation2$` ON `$RelationModel$`.fK_Id = `$Relation2$`.pK_Id WHERE `$RelationModel$`.`Id` = ?');
  });

  it('hasManyToMany', async () => {
    const relStub = sinon
      .stub(FakeSqliteDriver.prototype, 'executeOnDb')
      .onFirstCall()
      .returns(
        new Promise((resolve) => {
          resolve([
            {
              Id: 1,
            },
            {
              Id: 2,
            },
          ]);
        }),
      )
      .onSecondCall()
      .returns(
        new Promise((resolve) => {
          resolve([]);
        }),
      );

    const result = await RelationModel3.all().populate('Models');

    expect(relStub.calledTwice).to.be.true;
    expect(result).to.be.not.null;
    expect(relStub.firstCall.args[0]).to.equal('SELECT * FROM `RelationTable3`');
    expect(relStub.secondCall.args[0]).to.equal('SELECT `$JoinTable$`.`Id`,`$JoinTable$`.`owner_id`,`$JoinTable$`.`target_id`,`$Models$`.`Id` as `$Models$.Id`,`$Models$`.`Model4Property` as `$Models$.Model4Property` FROM `JoinTable` as `$JoinTable$` LEFT JOIN `RelationTable4` as `$Models$` ON `$JoinTable$`.target_id = `$Models$`.Id WHERE `$JoinTable$`.`owner_id` IN (?,?)');
  });
});

describe('Select query builder', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');

    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('group by simple', () => {
    const result = sqb().groupBy('Category').from('roles').columns(['id', 'parent_id', 'slug']).toDB();
    expect(result.expression).to.equal('SELECT `id`,`parent_id`,`slug` FROM `roles` GROUP BY `Category`');
  });

  it('group by raw', () => {
    const result = sqb().groupBy(new RawQuery('DATE(`CreatedAt`)')).from('roles').columns(['id', 'parent_id', 'slug']).toDB();
    expect(result.expression).to.equal('SELECT `id`,`parent_id`,`slug` FROM `roles` GROUP BY DATE(`CreatedAt`)');
  });

  it('wrap where date', () => {
    const result = sqb().from('roles').where(Wrapper.Date('CreatedAt'), 'abc').columns(['id', 'parent_id', 'slug']).toDB();
    expect(result.expression).to.equal('SELECT `id`,`parent_id`,`slug` FROM `roles` WHERE DATE(`CreatedAt`) = ?');
  });

  it('wrap where datetime', () => {
    const result = sqb().from('roles').where(Wrapper.DateTime('CreatedAt'), 'abc').columns(['id', 'parent_id', 'slug']).toDB();
    expect(result.expression).to.equal('SELECT `id`,`parent_id`,`slug` FROM `roles` WHERE DATETIME(`CreatedAt`) = ?');
  });

  it('wrap where three params', () => {
    const result = sqb().from('roles').where(Wrapper.DateTime('CreatedAt'), '<', 'abc').columns(['id', 'parent_id', 'slug']).toDB();
    expect(result.expression).to.equal('SELECT `id`,`parent_id`,`slug` FROM `roles` WHERE DATETIME(`CreatedAt`) < ?');
  });

  it('withRecursion simple', () => {
    const result = sqb().withRecursive('parent_id', 'id').from('roles').columns(['id', 'parent_id', 'slug']).toDB();
    expect(result.expression).to.equal('WITH RECURSIVE recursive_cte(id,parent_id,slug) AS ( SELECT `id`,`parent_id`,`slug` FROM `roles` UNION ALL SELECT `$recursive$`.`id`,`$recursive$`.`parent_id`,`$recursive$`.`slug` FROM `roles` as `$recursive$` INNER JOIN `recursive_cte` as `$recursive_cte$` ON `$recursive_cte$`.id = `$recursive$`.parent_id ) SELECT * FROM recursive_cte');
  });

  it('withRecursion with where', () => {
    const result = sqb().withRecursive('parent_id', 'id').from('roles').columns(['id', 'parent_id', 'slug']).where('id', 2).toDB();
    expect(result.expression).to.equal('WITH RECURSIVE recursive_cte(id,parent_id,slug) AS ( SELECT `id`,`parent_id`,`slug` FROM `roles` WHERE `id` = ? UNION ALL SELECT `$recursive$`.`id`,`$recursive$`.`parent_id`,`$recursive$`.`slug` FROM `roles` as `$recursive$` INNER JOIN `recursive_cte` as `$recursive_cte$` ON `$recursive_cte$`.id = `$recursive$`.parent_id ) SELECT * FROM recursive_cte');
    expect(result.bindings).to.be.an('array').to.include(2);
  });

  it('basic select', () => {
    const result = sqb().select('*').from('users').toDB();

    expect(result.expression).to.equal('SELECT * FROM `users`');
    expect(result.bindings).to.be.an('array').that.is.empty;
  });

  it('basic select with schema', () => {
    const result = sqb().select('*').from('users').database('spine').toDB();
    expect(result.expression).to.equal('SELECT * FROM `spine`.`users`');
  });

  it('multiple selects', () => {
    const result = sqb().select('foo').select('bar').select('tar').from('users').toDB();
    expect(result.expression).to.equal('SELECT `foo`,`bar`,`tar` FROM `users`');
  });

  it('multiple selects with aliases', () => {
    const result = sqb().select('foo', 'f').select('bar', 'b').select('tar', 't').from('users').toDB();
    expect(result.expression).to.equal('SELECT `foo` as `f`,`bar` as `b`,`tar` as `t` FROM `users`');
  });

  it('multiple selects by columns', () => {
    const result = sqb().columns(['foo', 'bar', 'tar']).from('users').toDB();
    expect(result.expression).to.equal('SELECT `foo`,`bar`,`tar` FROM `users`');
  });

  it('select with limit', () => {
    const result = sqb().select('*').from('users').take(1).toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` LIMIT ?');
  });

  it('select first', () => {
    const result = sqb().select('*').from('users');

    result.first();

    expect(result.toDB().expression).to.equal('SELECT * FROM `users` LIMIT ?');
    expect(result.toDB().bindings).to.be.an('array').to.include(1);
  });

  it('select with limit & skip', () => {
    const result = sqb().select('*').from('users').take(1).skip(10).toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` LIMIT ? OFFSET ?');
  });

  it('select with skip', () => {
    const result = sqb().select('*').from('users').skip(10).toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` LIMIT 18446744073709551615 OFFSET ?');
  });

  it('select with take & skip invalid args', () => {
    expect(() => {
      sqb().select('*').from('users').take(0);
    }).to.throw();

    expect(() => {
      sqb().select('*').from('users').skip(-1);
    }).to.throw();
  });

  it('where empty function', () => {
    const result = sqb()
      .select('*')
      .from('users')
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      .where(function (_builder: IWhereBuilder<unknown>) {})
      .toDB();

    expect(result.expression).to.eq('SELECT * FROM `users`');
  });

  it('select with order by', () => {
    const result = sqb().select('*').from('users').orderByDescending('name').toDB();
    expect(result.expression).to.equal('SELECT * FROM `users` ORDER BY name DESC');
  });

  it('select distinct', () => {
    const result = sqb().select('bar').from('users').distinct().toDB();
    expect(result.expression).to.equal('SELECT DISTINCT `bar` FROM `users`');
  });

  it('select distinct column check', () => {
    expect(() => {
      sqb().from('users').distinct();
    }).to.throw();

    expect(() => {
      sqb().select('*').from('users').distinct();
    }).to.throw();
  });

  it('select min', () => {
    let result = sqb().min('age').from('users').toDB().expression;
    expect(result).to.equal('SELECT MIN(`age`) FROM `users`');

    result = sqb().min('age', 'a').from('users').toDB().expression;
    expect(result).to.equal('SELECT MIN(`age`) as `a` FROM `users`');
  });

  it('select max', () => {
    let result = sqb().max('age').from('users').toDB().expression;
    expect(result).to.equal('SELECT MAX(`age`) FROM `users`');

    result = sqb().max('age', 'a').from('users').toDB().expression;
    expect(result).to.equal('SELECT MAX(`age`) as `a` FROM `users`');
  });

  it('select count', () => {
    let result = sqb().count('age').from('users').toDB().expression;
    expect(result).to.equal('SELECT COUNT(`age`) FROM `users`');

    result = sqb().count('age', 'a').from('users').toDB().expression;
    expect(result).to.equal('SELECT COUNT(`age`) as `a` FROM `users`');
  });

  it('select sum', () => {
    let result = sqb().sum('age').from('users').toDB().expression;
    expect(result).to.equal('SELECT SUM(`age`) FROM `users`');

    result = sqb().sum('age', 'a').from('users').toDB().expression;
    expect(result).to.equal('SELECT SUM(`age`) as `a` FROM `users`');
  });

  it('select avg', () => {
    let result = sqb().avg('age').from('users').toDB().expression;
    expect(result).to.equal('SELECT AVG(`age`) FROM `users`');

    result = sqb().avg('age', 'a').from('users').toDB().expression;
    expect(result).to.equal('SELECT AVG(`age`) as `a` FROM `users`');
  });

  it('select raw', () => {
    const result = sqb().select(RawQuery.create('LENGTH(`name`) as `len`')).select('bar', 'b').from('users').toDB().expression;
    expect(result).to.equal('SELECT LENGTH(`name`) as `len`,`bar` as `b` FROM `users`');
  });

  it('select function with * column', () => {
    const result = sqb().count('*').from('users').toDB().expression;
    expect(result).to.equal('SELECT COUNT(*) FROM `users`');
  });
});

describe('insert query builder', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');

    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('simple insert', () => {
    const result = iqb()
      .into('users')
      .values({
        id: 1,
        active: true,
        email: 'spine@spine.pl',
      })
      .toDB();

    expect(result.expression).to.equal('INSERT INTO `users` (`id`,`active`,`email`) VALUES (?,?,?)');
    expect(result.bindings).to.be.an('array').to.include.members([1, true, 'spine@spine.pl']);
  });

  it('insert with default values', () => {
    const result = iqb()
      .into('users')
      .values({
        id: 1,
        active: undefined,
        email: 'spine@spine.pl',
      })
      .toDB();

    expect(result.expression).to.equal('INSERT INTO `users` (`id`,`active`,`email`) VALUES (?,DEFAULT,?)');
    expect(result.bindings).to.be.an('array').to.include.members([1, 'spine@spine.pl']);
  });

  it('insert multiple values', () => {
    const vals = [
      {
        id: 1,
        active: undefined,
        email: 'spine@spine.pl',
      },
      {
        id: 2,
        active: true,
        email: 'spine2@spine.pl',
      },
    ];
    const result = iqb().into('users').values(vals).toDB();

    expect(result.expression).to.equal('INSERT INTO `users` (`id`,`active`,`email`) VALUES (?,DEFAULT,?),(?,?,?)');
    expect(result.bindings).to.be.an('array').to.include.members([1, 'spine@spine.pl', 2, true, 'spine2@spine.pl']);
  });

  it('insert with ignore', () => {
    const result = iqb()
      .into('users')
      .values({
        id: 1,
        active: true,
        email: 'spine@spine.pl',
      })
      .orIgnore()
      .toDB();

    expect(result.expression).to.equal('INSERT IGNORE INTO `users` (`id`,`active`,`email`) VALUES (?,?,?)');
    expect(result.bindings).to.be.an('array').to.include.members([1, true, 'spine@spine.pl', 'spine@spine.pl', true]);
  });

  it('insert with on duplicate', () => {
    const result = iqb()
      .into('users')
      .values({
        id: 1,
        active: true,
        email: 'spine@spine.pl',
      })
      .onDuplicate('id')
      .update(['email', 'active'])
      .toDB() as ICompilerOutput;

    expect(result.expression).to.equal('INSERT INTO `users` (`id`,`active`,`email`) VALUES (?,?,?) ON DUPLICATE KEY UPDATE `email` = ?,`active` = ?');
    expect(result.bindings).to.be.an('array').to.include.members([1, true, 'spine@spine.pl', 'spine@spine.pl', true]);
  });
});

describe('schema building', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');

    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('Should create history table with triggers', () => {
    const result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.int('Id').notNull().primaryKey().autoIncrement();
        table.string('Name').notNull();

        table.trackHistory();
      })
      .toDB() as ICompilerOutput[];

    const r = /\s{2,}/g;

    expect(result.length).to.be.eq(12);

    expect(result[0].expression).to.be.eq('CREATE TABLE `users` (`Id` INT NOT NULL AUTO_INCREMENT,`Name` VARCHAR(255) NOT NULL ,PRIMARY KEY (`Id`) )');
    expect(result[1].expression).to.be.eq('CREATE TABLE `users__history` LIKE `users`');
    expect(result[2].expression.replace(r, ' ')).to.be.eq(`ALTER TABLE \`users__history\` CHANGE COLUMN Id Id INT NOT NULL , DROP PRIMARY KEY;`);
    expect(result[3].expression.replace(r, ' ')).to.be.eq(`ALTER TABLE \`users__history\` ADD __action__ VARCHAR(8) DEFAULT 'insert' FIRST, ADD __revision__ INT(6) NOT NULL AFTER __action__, ADD __start__ DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER __revision__, ADD __end__ DATETIME AFTER __start__`);
    expect(result[4].expression.replace(r, ' ')).to.be.eq(`ALTER TABLE \`users__history\` ADD PRIMARY KEY (Id, __revision__)`);
    expect(result[5].expression.replace(r, ' ')).to.be.eq(`DELIMITER $$ CREATE TRIGGER users__history__insert_trigger BEFORE INSERT ON \`users__history\` FOR EACH ROW BEGIN DECLARE rev INT; SET rev = (SELECT IFNULL(MAX(__revision__), 0) FROM \`users__history\` WHERE Id = NEW.Id); SET NEW.__revision__ = rev + 1; END;`);
    expect(result[6].expression.replace(r, ' ')).to.be.eq('DROP TRIGGER IF EXISTS users__insert_trigger');
    expect(result[7].expression.replace(r, ' ')).to.be.eq('DROP TRIGGER IF EXISTS users__update_trigger');
    expect(result[8].expression.replace(r, ' ')).to.be.eq('DROP TRIGGER IF EXISTS users__delete_trigger');
    expect(result[9].expression.replace(r, ' ')).to.be.eq(`DELIMITER $$ CREATE TRIGGER users__insert_trigger AFTER INSERT ON \`users\` FOR EACH ROW BEGIN DECLARE rev INT; SET rev = (SELECT IFNULL(MAX(__revision__), 0) FROM \`users__history\` WHERE Id = NEW.Id); UPDATE \`users__history\` SET __end__ = NOW() WHERE Id = NEW.Id AND __revision__ = rev; INSERT INTO \`users__history\` SELECT 'insert', 0, NOW(), NULL, d.* FROM \`users\` AS d WHERE d.Id = NEW.Id; END;`);
    expect(result[10].expression.replace(r, ' ')).to.be.eq(`DELIMITER $$ CREATE TRIGGER users__update_trigger AFTER UPDATE ON \`users\` FOR EACH ROW BEGIN DECLARE rev INT; SET rev = (SELECT IFNULL(MAX(__revision__), 0) FROM \`users__history\` WHERE Id = NEW.Id); UPDATE \`users__history\` SET __end__ = NOW() WHERE Id = NEW.Id AND __revision__ = rev; INSERT INTO \`users__history\` SELECT 'update', 0, NOW(), NULL, d.* FROM \`users\` AS d WHERE d.Id = NEW.Id; END;`);
    expect(result[11].expression.replace(r, ' ')).to.be.eq(`DELIMITER $$ CREATE TRIGGER users__delete_trigger BEFORE DELETE ON \`users\` FOR EACH ROW BEGIN DECLARE rev INT; SET rev = (SELECT IFNULL(MAX(__revision__), 0) FROM \`users__history\` WHERE Id = NEW.Id); UPDATE \`users__history\` SET __end__ = NOW() WHERE Id = NEW.Id AND __revision__ = rev; INSERT INTO \`users__history\` SELECT 'delete', 0, NOW(), NULL, d.* FROM \`users\` AS d WHERE d.Id = NEW.Id; END;`);
  });

  it('should drop table', () => {
    const result = schqb().dropTable('users').toDB();
    expect(result.expression).to.eq('DROP TABLE `users`');
  });

  it('should drop table with schema', () => {
    const result = schqb().dropTable('users', 'test').toDB();
    expect(result.expression).to.eq('DROP TABLE `test`.`users`');
  });

  it('should drop table if exists', () => {
    const result = schqb().dropTable('users', 'test').ifExists().toDB();
    expect(result.expression).to.eq('DROP TABLE IF EXISTS `test`.`users`');
  });

  it('table with one foreigk key', () => {
    const result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.int('foo').notNull().primaryKey().autoIncrement();
        table.foreignKey('parent_id').references('group', 'id').onDelete(ReferentialAction.Cascade).onUpdate(ReferentialAction.Cascade);
      })
      .toDB() as ICompilerOutput[];

    expect(result[0].expression).to.eq('CREATE TABLE `users` (`foo` INT NOT NULL AUTO_INCREMENT ,PRIMARY KEY (`foo`) ,FOREIGN KEY (parent_id) REFERENCES group(id) ON DELETE CASCADE ON UPDATE CASCADE)');
  });

  it('table with default referential action', () => {
    const result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.int('foo').notNull().primaryKey().autoIncrement();
        table.foreignKey('parent_id').references('group', 'id');
      })
      .toDB() as ICompilerOutput[];

    expect(result[0].expression).to.eq('CREATE TABLE `users` (`foo` INT NOT NULL AUTO_INCREMENT ,PRIMARY KEY (`foo`) ,FOREIGN KEY (parent_id) REFERENCES group(id) ON DELETE NO ACTION ON UPDATE NO ACTION)');
  });

  it('column with one primary keys', () => {
    const result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.int('foo').notNull().primaryKey().autoIncrement();
      })
      .toDB() as ICompilerOutput[];

    expect(result[0].expression).to.equal('CREATE TABLE `users` (`foo` INT NOT NULL AUTO_INCREMENT ,PRIMARY KEY (`foo`) )');
  });

  it('column with multiple primary keys', () => {
    const result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.int('foo').notNull().primaryKey().autoIncrement();
        table.int('bar').notNull().primaryKey().autoIncrement();
      })
      .toDB() as ICompilerOutput[];

    expect(result[0].expression).to.equal('CREATE TABLE `users` (`foo` INT NOT NULL AUTO_INCREMENT,`bar` INT NOT NULL AUTO_INCREMENT ,PRIMARY KEY (`foo`,`bar`) )');
  });

  it('column with charset', () => {
    const result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.string('foo').charset('utf8');
      })
      .toDB() as ICompilerOutput[];

    expect(result[0].expression).to.contain("`foo` VARCHAR(255) CHARACTER SET 'utf8'");
  });

  it('column with collation', () => {
    const result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.string('foo').collation('utf8_bin');
      })
      .toDB() as ICompilerOutput[];

    expect(result[0].expression).to.contain("`foo` VARCHAR(255) COLLATE 'utf8_bin'");
  });

  it('column with default', () => {
    let result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.int('foo').unsigned().default().value(1);
      })
      .toDB() as ICompilerOutput[];

    expect(result[0].expression).to.eq('CREATE TABLE `users` (`foo` INT UNSIGNED DEFAULT 1  )');

    result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.string('foo').default().value('abc');
      })
      .toDB() as ICompilerOutput[];

    expect(result[0].expression).to.eq("CREATE TABLE `users` (`foo` VARCHAR(255) DEFAULT 'abc'  )");

    result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.timestamp('foo').default().raw(RawQuery.create('CURRENT_TIMESTAMP'));
      })
      .toDB() as ICompilerOutput[];

    expect(result[0].expression).to.contain('`foo` TIMESTAMP DEFAULT CURRENT_TIMESTAMP');

    result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.timestamp('foo').default().date();
      })
      .toDB() as ICompilerOutput[];

    expect(result[0].expression).to.contain('`foo` TIMESTAMP DEFAULT (CURRENT_DATE())');

    result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.timestamp('foo').default().dateTime();
      })
      .toDB() as ICompilerOutput[];

    expect(result[0].expression).to.eq('CREATE TABLE `users` (`foo` TIMESTAMP DEFAULT CURRENT_TIMESTAMP  )');
  });

  it('create index', () => {
    const result = inqb().table('metadata').unique().name('metadata_owners_idx').columns(['OwnerId', 'Key']).toDB();
    expect(result.expression).to.contain('CREATE UNIQUE INDEX `metadata_owners_idx` ON `metadata` (`OwnerId`,`Key`)');
  });

  it('column with auto increment', () => {
    const result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.int('foo').unsigned().autoIncrement();
      })
      .toDB() as ICompilerOutput[];

    expect(result[0].expression).to.contain('`foo` INT UNSIGNED AUTO_INCREMENT');
  });

  it('column with unsigned', () => {
    const result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.int('foo').unsigned();
      })
      .toDB() as ICompilerOutput[];

    expect(result[0].expression).to.contain('`foo` INT UNSIGNED');
  });

  it('column with comment', () => {
    const result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.text('foo').comment('spine comment');
      })
      .toDB() as ICompilerOutput[];

    expect(result[0].expression).to.contain("COMMENT 'spine comment'");
  });

  it('column with not null', () => {
    const result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.text('foo').notNull();
      })
      .toDB() as ICompilerOutput[];

    expect(result[0].expression).to.contain('`foo` TEXT NOT NULL');
  });

  it('create temporary table', () => {
    const result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.int('foo').notNull().primaryKey().autoIncrement();
        table.int('bar').notNull().primaryKey().autoIncrement();
        table.temporary();
      })
      .toDB() as ICompilerOutput[];

    expect(result[0].expression).to.equal('CREATE TEMPORARY TABLE `users` (`foo` INT NOT NULL AUTO_INCREMENT,`bar` INT NOT NULL AUTO_INCREMENT ,PRIMARY KEY (`foo`,`bar`) )');
  });

  it('Clone table shallow', () => {
    const result = schqb()
      .cloneTable((table) => {
        table.shallowClone('test', 'cloneTest');
      })
      .toDB();

    expect(result.length).to.eq(1);
    expect(result[0].expression).to.equal('CREATE TABLE `cloneTest` LIKE `test`');
  });

  it('Clone table deep', () => {
    const result = schqb()
      .cloneTable((table) => {
        table.deepClone('test', 'cloneTest');
      })
      .toDB();

    expect(result.length).to.eq(2);
    expect(result[0].expression).to.equal('CREATE TABLE `cloneTest` LIKE `test`');
    expect(result[1].expression).to.equal('INSERT INTO `cloneTest` SELECT * FROM `test`');
  });

  it('Clone table deep with filter', () => {
    const result = schqb()
      .cloneTable((table) => {
        table.deepClone('test', 'cloneTest', (query) => {
          query.where('id', '>', 10);
        });
      })
      .toDB();

    expect(result.length).to.eq(2);
    expect(result[0].expression).to.equal('CREATE TABLE `cloneTest` LIKE `test`');
    expect(result[1].expression).to.equal('INSERT INTO `cloneTest` SELECT * FROM `test` WHERE `id` > ?');
    expect(result[1].bindings[0]).to.equal(10);
  });

  it('Should drop column', () => {
    const result = schqb()
      .alterTable('test', (table) => {
        table.dropColumn('Id');
      })
      .toDB();

    expect(result.length).to.eq(1);
    expect(result[0].expression).to.equal('ALTER TABLE `test` DROP COLUMN Id');
  });

  it('Should rename table', () => {
    const result = schqb()
      .alterTable('test', (table) => {
        table.rename('test_new');
      })
      .toDB();

    expect(result.length).to.eq(1);
    expect(result[0].expression).to.equal('ALTER TABLE `test` RENAME TO `test_new`');
  });

  it('Should add multiple columns', () => {
    const result = schqb()
      .alterTable('test', (table) => {
        table.int('Id2').after('Id');
        table.int('Id3').after('Id2');
      })
      .toDB();

    expect(result.length).to.eq(2);
    expect(result[0].expression).to.equal('ALTER TABLE `test` ADD `Id2` INT AFTER `Id`');
    expect(result[1].expression).to.equal('ALTER TABLE `test` ADD `Id3` INT AFTER `Id2`');
  });

  it('Should modify column', () => {
    const result = schqb()
      .alterTable('test', (table) => {
        table.string('Id2', 255).modify();
      })
      .toDB();

    expect(result.length).to.eq(1);
    expect(result[0].expression).to.equal('ALTER TABLE `test` MODIFY `Id2` VARCHAR(255)');
  });

  it('Should rename column', () => {
    const result = schqb()
      .alterTable('test', (table) => {
        table.string('Id2').rename('Id3');
      })
      .toDB();

    expect(result.length).to.eq(1);
    expect(result[0].expression).to.equal('ALTER TABLE `test` RENAME COLUMN `Id2` TO `Id3`');
  });

  it('column types', () => {
    const result = schqb()
      .createTable('users', (table: TableQueryBuilder) => {
        table.smallint('foo');
        table.tinyint('foo');
        table.mediumint('foo');
        table.int('foo');
        table.bigint('foo');
        table.tinytext('foo');
        table.mediumtext('foo');
        table.longtext('foo');
        table.text('foo');
        table.string('foo');
        table.float('foo');
        table.decimal('foo');
        table.boolean('foo');
        table.bit('foo');
        table.double('foo');
        table.date('foo');
        table.time('foo');
        table.dateTime('foo');
        table.timestamp('foo');
        table.json('foo');
        table.set('foo', ['bar', 'baz']);
      })
      .toDB() as ICompilerOutput[];

    expect(result[0].expression).to.contain('`foo` SMALLINT');
    expect(result[0].expression).to.contain('`foo` TINYINT');
    expect(result[0].expression).to.contain('`foo` INT');
    expect(result[0].expression).to.contain('`foo` BIGINT');
    expect(result[0].expression).to.contain('`foo` TINYTEXT');
    expect(result[0].expression).to.contain('`foo` MEDIUMTEXT');
    expect(result[0].expression).to.contain('`foo` LONGTEXT');
    expect(result[0].expression).to.contain('`foo` LONGTEXT');
    expect(result[0].expression).to.contain('`foo` TEXT');
    expect(result[0].expression).to.contain('`foo` VARCHAR(255)'); // string
    expect(result[0].expression).to.contain('`foo` FLOAT(8,2)');
    expect(result[0].expression).to.contain('`foo` DECIMAL(8,2)');
    expect(result[0].expression).to.contain('`foo` BOOLEAN'); // boolean
    expect(result[0].expression).to.contain('`foo` BIT');
    expect(result[0].expression).to.contain('`foo` DOUBLE(8,2)');
    expect(result[0].expression).to.contain('`foo` DATE');
    expect(result[0].expression).to.contain('`foo` TIME');
    expect(result[0].expression).to.contain('`foo` DATETIME');
    expect(result[0].expression).to.contain('`foo` TIMESTAMP');
    expect(result[0].expression).to.contain('`foo` JSON');
    expect(result[0].expression).to.contain("`foo` SET('bar','baz')");
  });
});
