import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { InsertBehaviour, IWhereBuilder, MigrationTransactionMode, Orm } from '@spinajs/orm';
import { DI } from '@spinajs/di';
import { DateTime } from 'luxon';

import { MySqlOrmDriver } from '../src/index.js';
import { User } from './models/User.js';

import './migrations/TestMigration_2022_02_08_01_13_00.js';
import './models/TestModel.js';

const expect = chai.expect;
chai.use(chaiAsPromised);
export const TEST_MIGRATION_TABLE_NAME = 'orm_migrations';

export class ConnectionConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
            layout: '{datetime} {level} {message} {error} duration: {duration} ms ({logger})',
          },
          // {
          //   name: 'Console',
          //   type: 'ConsoleTarget',
          // },
        ],

        rules: [{ name: '*', level: 'trace', target: 'Console' }],
      },
      db: {
        Migration: {
          Startup: false,
        },
        Connections: [
          {
            Driver: 'orm-driver-mysql',
            Name: 'mysql',
            Host: '127.0.0.1',
            Password: 'root',
            User: 'root',
            Database: 'test',
            Port: 3306,
            Migration: {
              Table: TEST_MIGRATION_TABLE_NAME,
              OnStartup: true,
              Transaction: {
                Mode: MigrationTransactionMode.PerMigration,
              },
            },
          },
        ],
      },
    };
  }
}

export function db() {
  return DI.get(Orm);
}

describe('Mysql connection test', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');
    await DI.resolve(Orm);
    await db().Connections.get('mysql').schema().dropTable('user_test');
    await db().Connections.get('mysql').schema().dropTable('test_model');
    await db().Connections.get('mysql').schema().dropTable('orm_migrations');
  });

  it('Should connect', async () => {
    const result = await db().Connections.get('mysql').ping();
    expect(result).to.equal(true);
  });
});

describe('Mysql driver migration, updates, deletions & inserts', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');
    await DI.resolve(Orm);
    await db().Connections.get('mysql').truncate('user_test');
    await db().Connections.get('mysql').schema().dropTable('user_test');
    await db().Connections.get('mysql').schema().dropTable('test_model');
    await db().Connections.get('mysql').schema().dropTable('orm_migrations');
  });

  it('Should migrate', async () => {
    await db().migrateUp();

    await db().Connections.get('mysql').select().from('user_test');
    await expect(db().Connections.get('mysql').select().from('notexisted')).to.be.rejected;
  });

  it('Should check if table exists', async () => {
    await db().migrateUp();

    const exists = await db().Connections.get('mysql').schema().tableExists('user_test');
    const notExists = await db().Connections.get('mysql').schema().tableExists('user2');

    expect(exists).to.eq(true);
    expect(notExists).to.eq(false);
  });

  it('should insert query', async () => {
    await db().migrateUp();
    const iResult = await db().Connections.get('mysql').insert().into('user_test').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    const result: User = (await db().Connections.get('mysql').select().from('user_test').orderByDescending('Id').first()) as User;

    expect(iResult.RowsAffected).to.eq(1);
    expect(iResult.LastInsertId).to.gt(0);
    expect(result).to.be.not.null;
    expect(result.Id).to.gt(0);
    expect(result.Name).to.eq('test');
  });

  it('should delete', async () => {
    await db().migrateUp();
    await db().Connections.get('mysql').insert().into('user_test').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    await db().Connections.get('mysql').del().from('user_test').where('id', '!=', 0);

    const result = await db().Connections.get('mysql').select().from('user_test').orderByDescending('Id').first();
    expect(result).to.be.undefined;
  });

  it('should update', async () => {
    await db().migrateUp();
    const iResult = await db().Connections.get('mysql').insert().into('user_test').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    const uResult = await db()
      .Connections.get('mysql')
      .update()
      .in('user_test')
      .update({
        Name: 'test updated',
      })
      .where('id', iResult.LastInsertId);

    const result: User = (await db().Connections.get('mysql').select().from('user_test').orderByDescending('Id').first()) as User;
    expect(uResult.RowsAffected).to.eq(1);
    expect(result).to.be.not.null;
    expect(result.Name).to.eq('test updated');
  });
});

describe('mysql model functions', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');
    await DI.resolve(Orm);
    await db().Connections.get('mysql').schema().dropTable('user_test');
    await db().Connections.get('mysql').schema().dropTable('test_model');
    await db().Connections.get('mysql').schema().dropTable('orm_migrations');

    await db().migrateUp();
    await db().reloadTableInfo();
  });

  it('should model create', async () => {
    const user = await User.create({
      Name: 'test',
      Password: 'test_password',
    });

    const result: User = (await db().Connections.get('mysql').select().from('user_test').orderByDescending('Id').first()) as User;

    expect(result).to.be.not.null;
    expect(result.Id).to.gt(0);
    expect(result.Name).to.eq('test');
    expect(result.Password).to.eq('test_password');

    expect(user).to.be.not.null;
    expect(user.Id).to.gt(0);
    expect(user.Name).to.eq('test');
    expect(user.Password).to.eq('test_password');
  });

  it('should batch insert models and fill primary keys', async () => {
    const users = [
      new User({ Name: 'batch_user_1', Password: 'password1' }),
      new User({ Name: 'batch_user_2', Password: 'password2' }),
      new User({ Name: 'batch_user_3', Password: 'password3' }),
    ];

    await User.insert(users);

    // All primary keys should be filled
    expect(users[0].Id).to.be.gt(0);
    expect(users[1].Id).to.be.gt(0);
    expect(users[2].Id).to.be.gt(0);

    // Primary keys should be sequential
    expect(users[1].Id).to.eq(users[0].Id + 1);
    expect(users[2].Id).to.eq(users[1].Id + 1);

    // Verify data is persisted correctly
    const allUsers = await User.all();
    expect(allUsers.length).to.eq(3);

    const dbUser1 = await User.get(users[0].Id);
    const dbUser2 = await User.get(users[1].Id);
    const dbUser3 = await User.get(users[2].Id);

    expect(dbUser1.Name).to.eq('batch_user_1');
    expect(dbUser2.Name).to.eq('batch_user_2');
    expect(dbUser3.Name).to.eq('batch_user_3');
  });

  it('should batch insert single model and fill primary key', async () => {
    const user = new User({ Name: 'single_batch', Password: 'password' });

    await User.insert([user]);

    expect(user.Id).to.be.gt(0);

    const dbUser = await User.get(user.Id);
    expect(dbUser.Name).to.eq('single_batch');
  });

  // Note: InsertBehaviour is not supported with array inserts, testing single model InsertOrUpdate instead
  it('should insert with InsertOrUpdate and fill primary key', async () => {
    const user = new User({ Name: 'upsert_user_1', Password: 'password1' });

    await User.insert(user, InsertBehaviour.InsertOrUpdate);

    expect(user.Id).to.be.gt(0);

    const dbUser = await User.get(user.Id);
    expect(dbUser.Name).to.eq('upsert_user_1');
  });
});

describe('MySql queries', () => {
  beforeEach(async () => {
    DI.clearCache();

    DI.register(ConnectionConf).as(Configuration);
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');
    await DI.resolve(Orm);

    await db().Connections.get('mysql').schema().dropTable('user_test');
    await db().Connections.get('mysql').schema().dropTable('test_model');
    await db().Connections.get('mysql').schema().dropTable('orm_migrations');

    await db().migrateUp();
    await db().reloadTableInfo();
  });

  after(async () => {
    await db().Connections.get('mysql').disconnect();
  });

  it('should select and sort', async () => {
    await db().Connections.get('mysql').insert().into('user_test').values({
      Name: 'a',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    await db().Connections.get('mysql').insert().into('user_test').values({
      Name: 'b',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    const userQuery = User.where(function (this: IWhereBuilder<User>) {
      this.where({ Name: 'a' });
    }).orderBy('Name');

    expect(userQuery).to.be.fulfilled;
  });

  it('should select to model', async () => {
    const result = await db().Connections.get('mysql').insert().into('user_test').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    const user = await User.get(result.LastInsertId);

    expect(user).instanceOf(User);
    expect(user.Id).to.gt(0);
    expect(user.Name).to.eq('test');
  });

  it('should map datetime', async () => {
    await db().Connections.get('mysql').insert().into('user_test').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    const user = await User.last();

    expect(user).instanceOf(User);
    expect(user.Name).to.eq('test');
    expect(user.CreatedAt).instanceof(DateTime);
  });

  it('should run on duplicate', async () => {
    const iResult = await db().Connections.get('mysql').insert().into('user_test').values({
      Name: 'test not duplicated',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    const u = new User({ Name: 'test not duplicated', Password: 'test_password_duplicated' });
    await User.insert(u, InsertBehaviour.InsertOrUpdate);
    const user = await User.get(iResult.LastInsertId);
    const all = await User.all();

    expect(all.length).to.eq(1);
    expect(user).instanceOf(User);
    expect(user.CreatedAt).instanceof(DateTime);
    expect(user.Name).to.eq('test not duplicated');
    expect(user.Password).to.eq('test_password_duplicated');
  });
});
