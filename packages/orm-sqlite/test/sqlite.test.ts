/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-floating-promises */
import { TestMigration_2022_02_08_01_13_00 } from './migrations/TestMigration_2022_02_08_01_13_00';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { SqliteOrmDriver } from './../src/index';
import { DI } from '@spinajs/di';
import { Orm, MigrationTransactionMode, Migration, OrmDriver, OrmMigration, QueryContext, InsertBehaviour } from '@spinajs/orm';
import * as _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { User } from './models/User';
import * as sinon from 'sinon';
import { DateTime } from 'luxon';
import { dir, mergeArrays } from './util';
import { TestModel } from './models/TestModel';
import { TestOwned } from './models/TestOwned';
import { TestMany } from './models/TestMany';

const expect = chai.expect;
chai.use(chaiAsPromised);

export const TEST_MIGRATION_TABLE_NAME = 'orm_migrations';

export class ConnectionConf2 extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: {
          targets: [
            {
              name: 'Empty',
              type: 'BlackHoleTarget',
              layout: '{datetime} {level} {message} {error} duration: {duration} ms ({logger})',
            },
          ],

          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
        db: {
          Migration: {
            Startup: false,
          },
          Connections: [
            {
              Driver: 'orm-driver-sqlite',
              Filename: ':memory:',
              Name: 'sqlite',
              Migration: {
                Table: TEST_MIGRATION_TABLE_NAME,

                Transaction: {
                  Mode: MigrationTransactionMode.PerMigration,
                },
              },
            },
          ],
        },
      },
      mergeArrays,
    );

    /**
     * For testing, clean out all dirs from another modules
     */
    this.set('system.dirs', {
      models: [dir('./models')],
      migrations: [dir('./migrations')],
    });
  }
}

export class ConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: {
          targets: [
            {
              name: 'Empty',
              type: 'BlackHoleTarget',
              layout: '{datetime} {level} {message} {error} duration: {duration} ({logger})',
            },
          ],

          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },

        db: {
          Connections: [
            {
              Driver: 'orm-driver-sqlite',
              Filename: ':memory:',
              Name: 'sqlite',
              Migration: {
                Table: TEST_MIGRATION_TABLE_NAME,
              },
            },
          ],
        },
      },
      mergeArrays,
    );

    this.set('system.dirs', {
      models: [dir('./models')],
      migrations: [dir('./migrations')],
    });
  }
}

export function db() {
  return DI.get(Orm);
}

describe('Sqlite driver migration, updates, deletions & inserts', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    await DI.resolve(Orm);
  });

  it('Should migrate', async () => {
    await db().migrateUp();

    await db().Connections.get('sqlite').select().from('user');
    await expect(db().Connections.get('sqlite').select().from('notexisted')).to.be.rejected;
  });

  it('Should create schema builder', () => {
    const result = db()
      .Connections.get('sqlite')
      .schema()
      .createTable('test', (table) => {
        table.timestamp('timestamp');
        table.enum('enum', ['a', 'b', 'c']);
      })
      .toDB();

    expect(result.expression).to.eq('CREATE TABLE `test` (`timestamp` TEXT,`enum` TEXT )');
  });

  it('Should check if table exists', async () => {
    await db().migrateUp();

    const exists = await db().Connections.get('sqlite').schema().tableExists('user');
    const notExists = await db().Connections.get('sqlite').schema().tableExists('user2');

    expect(exists).to.eq(true);
    expect(notExists).to.eq(false);
  });

  it('should insert query', async () => {
    await db().migrateUp();
    const iResult = await db().Connections.get('sqlite').insert().into('user').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    const result: User = await db().Connections.get('sqlite').select<User>().from('user').first();

    expect(iResult.LastInsertId).to.eq(1);
    expect(iResult.RowsAffected).to.eq(1);
    expect(result).to.be.not.null;
    expect(result.Id).to.eq(1);
    expect(result.Name).to.eq('test');
  });

  it('should insert or ignore  query', () => {
    const result = db()
      .Connections.get('sqlite')
      .insert()
      .into('user')
      .values({
        Name: 'test',
        Password: 'test_password',
        CreatedAt: '2019-10-18',
      })
      .orIgnore()
      .toDB();

    expect(result.expression).to.eq('INSERT OR IGNORE INTO `user` (`Name`,`Password`,`CreatedAt`) VALUES (?,?,?)');
  });

  it('should delete', async () => {
    await db().migrateUp();
    await db().Connections.get('sqlite').insert().into('user').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    await db().Connections.get('sqlite').del().from('user').where('id', 1);

    const result = await db().Connections.get('sqlite').select().from('user').first();
    expect(result).to.be.undefined;
  });

  it('should update', async () => {
    await db().migrateUp();
    await db().Connections.get('sqlite').insert().into('user').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    await db()
      .Connections.get('sqlite')
      .update()
      .in('user')
      .update({
        Name: 'test updated',
      })
      .where('id', 1);

    const result: User = await db().Connections.get('sqlite').select<User>().from('user').first();
    expect(result).to.be.not.null;
    expect(result.Name).to.eq('test updated');
  });
});

describe('Sqlite driver migrate', () => {
  beforeEach(async () => {
    DI.clearCache();

    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    await DI.resolve(Orm);
  });

  it('Should migrate create migrate table', async () => {
    await db().migrateUp();
    const mTable = await db().Connections.get('sqlite').tableInfo(TEST_MIGRATION_TABLE_NAME);
    const mResult = await db().Connections.get('sqlite').select().from(TEST_MIGRATION_TABLE_NAME).first();
    expect(mTable).to.be.not.null;
    expect(mResult).to.be.not.null;
    expect((mResult as any).Migration).to.eq('TestMigration_2022_02_08_01_13_00');
  });

  it('Should not migrate twice', async () => {
    const spy = sinon.spy(TestMigration_2022_02_08_01_13_00.prototype, 'up');

    await db().migrateUp();
    await db().migrateUp();

    expect(spy.calledOnce).to.be.true;
  });

  it('Should migrate', async () => {
    await db().migrateUp();
    await db().Connections.get('sqlite').insert().into('user').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });
    const result = await db().Connections.get('sqlite').select().from('user').first();

    expect(result).to.be.not.null;
    expect(result).to.eql({
      Id: 1,
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });
  });
});

describe('Sqlite model functions', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    await DI.resolve(Orm);

    await db().migrateUp();
    await db().reloadTableInfo();
  });

  it('should model create', async () => {
    const user = await User.create({
      Name: 'test',
      Password: 'test_password',
    });

    const result: User = await db().Connections.get('sqlite').select<User>().from('user').first();

    expect(result).to.be.not.null;
    expect(result.Id).to.eq(1);
    expect(result.Name).to.eq('test');
    expect(result.Password).to.eq('test_password');

    expect(user).to.be.not.null;
    expect(user.Id).to.eq(1);
    expect(user.Name).to.eq('test');
    expect(user.Password).to.eq('test_password');
  });

  it('should model be inserted with one-to-one relation', async () => {
    const model = new TestModel();
    await model.insert();

    expect(model.Id).to.eq(1);

    const owned = new TestOwned();
    owned.attach(model);

    await owned.insert();

    expect(owned.Id).to.eq(1);

    const check = await TestOwned.getOrFail(1);
    await check.Owner.populate();

    expect(check.Owner.Value.constructor.name).to.eq('TestModel');
    expect(check.Owner.Value.Id).to.eq(1);
  });

  it('should model be updated with one-to-one relation', async () => {
    const model = new TestModel();
    await model.insert();
    const model2 = new TestModel();
    await model2.insert();

    expect(model.Id).to.eq(1);
    expect(model2.Id).to.eq(2);

    const owned = new TestOwned();
    owned.attach(model);

    await owned.insert();

    expect(owned.Id).to.eq(1);

    owned.attach(model2);
    await owned.update();

    const check = await TestOwned.getOrFail(1);
    await check.Owner.populate();

    expect(check.Owner.Value.constructor.name).to.eq('TestModel');
    expect(check.Owner.Value.Id).to.eq(2);
  });

  it('model should attach & set one-to many relations', async () => {
    const model = new TestModel();
    await model.insert();

    const m1 = new TestMany();
    const m2 = new TestMany();
    const m3 = new TestMany();
    const m4 = new TestMany();

    model.attach(m1);
    model.attach(m2);
    model.attach(m3);
    model.attach(m4);

    await m1.insert();
    await m2.insert();
    await m3.insert();
    await m4.insert();

    const check = await TestModel.where({ Id: 1 }).populate('Many').first();

    expect(check.Many.length).to.eq(4);
    expect(check.Many[0].Id).to.eq(1);
    expect(check.Many[1].Id).to.eq(2);
    expect(check.Many[2].Id).to.eq(3);
    expect(check.Many[3].Id).to.eq(4);

    expect(check.Many[0].constructor.name).to.eq('TestMany');
  });

  it('model relation set should work', async () => {
    const model = new TestModel();
    await model.insert();

    const m0 = new TestMany();
    model.attach(m0);

    await m0.insert();

    const m1 = new TestMany();
    const m2 = new TestMany();
    const m3 = new TestMany();
    const m4 = new TestMany();

    await model.Many.set([m1, m2, m3, m4]);

    const check = await TestModel.where({ Id: 1 }).populate('Many').first();

    expect(check.Many.length).to.eq(4);
    expect(check.Many[0].Id).to.eq(2);
    expect(check.Many[1].Id).to.eq(3);
    expect(check.Many[2].Id).to.eq(4);
    expect(check.Many[3].Id).to.eq(5);

    const c2 = await TestMany.get(m0.Id);
    expect(c2).to.eq(undefined);
  });

  it('model relation set should update', async () => {
    const model = new TestModel();
    await model.insert();

    const m0 = new TestMany();
    model.attach(m0);

    await m0.insert();

    const m1 = new TestMany();
    const m2 = new TestMany();
    const m3 = new TestMany();
    const m4 = new TestMany();

    await model.Many.set([m1, m2, m3, m4]);

    let check = await TestModel.where({ Id: 1 }).populate('Many').first();

    expect(check.Many.length).to.eq(4);
    expect(check.Many[0].Id).to.eq(2);
    expect(check.Many[1].Id).to.eq(3);
    expect(check.Many[2].Id).to.eq(4);
    expect(check.Many[3].Id).to.eq(5);

    m1.Val = 'test';
    await model.Many.set([m1, m2, m3, m4]);

    check = await TestModel.where({ Id: 1 }).populate('Many').first();
    expect(check.Many[0].Val).to.eq('test');
    expect(check.Many[0].Id).to.eq(2);
    expect(check.Many[1].Id).to.eq(3);
    expect(check.Many[2].Id).to.eq(4);
    expect(check.Many[3].Id).to.eq(5);
  });

  it('model relation union should work', async () => {
    const model = new TestModel();
    await model.insert();

    const m0 = new TestMany();
    model.attach(m0);

    await m0.insert();

    const m1 = new TestMany();
    const m2 = new TestMany();
    const m3 = new TestMany();
    const m4 = new TestMany();

    await model.Many.union([m1, m2, m3, m4]);

    const check = await TestModel.where({ Id: 1 }).populate('Many').first();

    expect(check.Many.length).to.eq(5);
    expect(check.Many[0].Id).to.eq(1);
    expect(check.Many[1].Id).to.eq(2);
    expect(check.Many[2].Id).to.eq(3);
    expect(check.Many[3].Id).to.eq(4);
    expect(check.Many[4].Id).to.eq(5);
  });

  it('model relation diff should work', async () => {
    const model = new TestModel();
    await model.insert();

    const m0 = new TestMany();
    model.attach(m0);

    await m0.insert();

    const m1 = new TestMany();
    const m2 = new TestMany();

    await model.Many.diff([m0, m1, m2]);

    const check = await TestModel.where({ Id: 1 }).populate('Many').first();

    expect(check.Many.length).to.eq(2);
    expect(check.Many[0].Id).to.eq(2);
    expect(check.Many[1].Id).to.eq(3);
  });

  it('model relation intersection should work', async () => {
    const model = new TestModel();
    await model.insert();

    const m0 = new TestMany();
    model.attach(m0);

    await m0.insert();

    const m1 = new TestMany();
    const m2 = new TestMany();

    await model.Many.intersection([m0, m1, m2]);

    const check = await TestModel.where({ Id: 1 }).populate('Many').first();

    expect(check.Many.length).to.eq(1);
    expect(check.Many[0].Id).to.eq(1);
  });
});

describe('Sqlite queries', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    await DI.resolve(Orm);

    await db().migrateUp();
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('should select and sort', async () => {
    await db().Connections.get('sqlite').insert().into('user').values({
      Name: 'a',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    await db().Connections.get('sqlite').insert().into('user').values({
      Name: 'b',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    const userQuery = User.where(function () {
      this.where({ Name: 'a' });
    }).orderBy('Name');

    return expect(userQuery).to.be.fulfilled;
  });

  it('should select to model', async () => {
    await db().Connections.get('sqlite').insert().into('user').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    const user = await User.get(1);

    expect(user).instanceOf(User);
    expect(user.Id).to.eq(1);
    expect(user.Name).to.eq('test');
  });

  it('should map datetime', async () => {
    await db().Connections.get('sqlite').insert().into('user').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    const user = await User.get(1);

    expect(user).instanceOf(User);
    expect(user.CreatedAt).instanceof(DateTime);
  });

  it('should run on duplicate', async () => {
    await db().Connections.get('sqlite').insert().into('user').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    await User.insert(new User({ Name: 'test', Password: 'test_password_2', CreatedAt: DateTime.fromFormat('2019-10-19', 'yyyy-MM-dd') }), InsertBehaviour.InsertOrUpdate);

    const all = await User.all();
    const user = await User.get(1);

    expect(user).instanceOf(User);
    expect(user.CreatedAt).instanceof(DateTime);
    expect(user.Name).to.eq('test');
    expect(user.Password).to.eq('test_password_2');
    expect(all.length).to.eq(1);
  });
});

describe('Sqlite driver migrate with transaction', () => {
  beforeEach(() => {
    DI.clearCache();

    DI.register(ConnectionConf2).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('Should commit migration', async () => {
    const orm = await DI.resolve(Orm);
    const driver = orm.Connections.get('sqlite');
    const trSpy = sinon.spy(driver, 'transaction');
    const exSpy = sinon.spy(driver, 'execute');

    await orm.migrateUp();

    expect(trSpy.calledOnce).to.be.true;
    expect(exSpy.getCall(3).args[0]).to.eq('BEGIN TRANSACTION');
    expect(exSpy.getCall(10).args[0]).to.eq('COMMIT');

    expect(driver.execute('SELECT * FROM user', null, QueryContext.Select)).to.be.fulfilled;

    const result = (await driver.execute(`SELECT * FROM ${TEST_MIGRATION_TABLE_NAME}`, null, QueryContext.Select)) as unknown[];
    expect(result[0]).to.be.not.undefined;
    expect(result[0]).to.be.not.null;
    expect((result[0] as any).Migration).to.eq('TestMigration_2022_02_08_01_13_00');
  });

  it('Should rollback migration', async () => {
    @Migration('sqlite')
    class MigrationFailed_2022_02_08_01_13_00 extends OrmMigration {
      public async up(connection: OrmDriver): Promise<void> {
        await connection.insert().into('not_exists').values({ id: 1 });
      }
      public down(_connection: OrmDriver): Promise<void> {
        return;
      }
    }

    class Fake2Orm extends Orm {
      constructor() {
        super();

        this.Migrations.length = 0;
        this.Models.length = 0;
        this.registerMigration(MigrationFailed_2022_02_08_01_13_00);
      }
    }
    DI.register(Fake2Orm).as(Orm);
    const orm = await DI.resolve(Orm);
    const driver = orm.Connections.get('sqlite');
    const trSpy = sinon.spy(driver, 'transaction');
    const exSpy = sinon.spy(driver, 'execute');

    try {
      await orm.migrateUp();
    } catch {}

    expect(trSpy.calledOnce).to.be.true;
    expect(exSpy.getCall(3).args[0]).to.eq('BEGIN TRANSACTION');
    expect(exSpy.getCall(5).args[0]).to.eq('ROLLBACK');

    expect(driver.execute('SELECT * FROM user', null, QueryContext.Select)).to.be.rejected;
    const result = (await driver.execute(`SELECT * FROM ${TEST_MIGRATION_TABLE_NAME}`, null, QueryContext.Select)) as unknown[];
    expect(result.length).to.be.eq(0);

    DI.unregister(Fake2Orm);
    DI.unregister(MigrationFailed_2022_02_08_01_13_00);
  });
});
