import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { ICompilerOutput, InsertBehaviour, IWhereBuilder, MigrationTransactionMode, Orm } from '@spinajs/orm';
import { DI } from '@spinajs/di';
import { DateTime } from 'luxon';

import { MySqlOrmDriver } from '../src/index.js';
import { User } from './models/User.js';

import './migrations/TestMigration_2022_02_08_01_13_00.js';
import './migrations/TestMigration_2022_02_08_01_14_00.js';
import './models/TestModel.js';
import './models/UserMetadata.js';

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
            Name: 'mysql-2',
            Host: '127.0.0.1',
            Password: 'root',
            User: 'root',
            Database: 'test-2',
            Port: 3306,
            Migration: {
              Table: TEST_MIGRATION_TABLE_NAME,
              OnStartup: true,
              Transaction: {
                Mode: MigrationTransactionMode.PerMigration,
              },
            },
          },
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
    await db().Connections.get('mysql').truncate('user_test');

    
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
   
    await db().Connections.get('mysql').truncate('user_test');

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
    await db().Connections.get('mysql').truncate('user_test');
 
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

describe('MySql transactions', () => {
  beforeEach(async () => {
    DI.clearCache();

    DI.register(ConnectionConf).as(Configuration);
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');
    await DI.resolve(Orm);
    await db().Connections.get('mysql').truncate('user_test');
 
  });

  after(async () => {
    await db().Connections.get('mysql').disconnect();
  });

  it('should commit transaction on success', async () => {
    const result =  await db().Connections.get('mysql').transaction(async () => {
      await db().Connections.get('mysql').insert().into('user_test').values({
        Name: 'transaction_user_1',
        Password: 'password1',
        CreatedAt: '2024-01-01',
      });

      await db().Connections.get('mysql').insert().into('user_test').values({
        Name: 'transaction_user_2',
        Password: 'password2',
        CreatedAt: '2024-01-01',
      });
    });

    await result.commit();

    const users = await User.all();
    expect(users.length).to.eq(2);
    expect(users.find(u => u.Name === 'transaction_user_1')).to.not.be.undefined;
    expect(users.find(u => u.Name === 'transaction_user_2')).to.not.be.undefined;
  });

  it('should rollback transaction on error', async () => {
    try {
      await db().Connections.get('mysql').transaction(async () => {
        await db().Connections.get('mysql').insert().into('user_test').values({
          Name: 'rollback_user_1',
          Password: 'password1',
          CreatedAt: '2024-01-01',
        });

        // This should be rolled back
        throw new Error('Intentional error for rollback test');
      });
    } catch (err) {
      // Expected error
      expect((err as Error).message).to.eq('Intentional error for rollback test');
    }

    const users = await User.all();
    expect(users.length).to.eq(0);
    expect(users.find(u => u.Name === 'rollback_user_1')).to.be.undefined;
  });

  it('should rollback all changes when later query fails', async () => {
    try {
      await db().Connections.get('mysql').transaction(async () => {
        // First insert should succeed
        await db().Connections.get('mysql').insert().into('user_test').values({
          Name: 'first_insert',
          Password: 'password',
          CreatedAt: '2024-01-01',
        });

        // Second insert into non-existent table should fail
        await db().Connections.get('mysql').insert().into('non_existent_table').values({
          Name: 'should_fail',
        });
      });
    } catch (err) {
      // Expected error - table doesn't exist
    }

    // First insert should also be rolled back
    const users = await User.all();
    expect(users.length).to.eq(0);
  });

  it('should handle transaction with model operations', async () => {
    const result = await db().Connections.get('mysql').transaction(async () => {
      await User.create({
        Name: 'model_transaction_user',
        Password: 'password',
      });
    });

    await result.commit();

    const user = await User.where('Name', 'model_transaction_user').first();
    expect(user).to.not.be.undefined;
    expect(user.Name).to.eq('model_transaction_user');
  });

  it('should rollback model operations on error', async () => {
    try {
      await db().Connections.get('mysql').transaction(async () => {
        await User.create({
          Name: 'model_rollback_user',
          Password: 'password',
        });

        throw new Error('Rollback model transaction');
      });
    } catch (err) {
      // Expected
    }

    const user = await User.where('Name', 'model_rollback_user').first();
    expect(user).to.be.undefined;
  });

  it('should handle empty transaction callback', async () => {
    await expect((await db().Connections.get('mysql').transaction()).commit()).to.be.fulfilled;
  });

  it('should handle multiple sequential transactions', async () => {
    // First transaction
    const  res = await db().Connections.get('mysql').transaction(async () => {
      await db().Connections.get('mysql').insert().into('user_test').values({
        Name: 'seq_transaction_1',
        Password: 'password',
        CreatedAt: '2024-01-01',
      });
    });



    // Second transaction
    const res2 = await db().Connections.get('mysql').transaction(async () => {
      await db().Connections.get('mysql').insert().into('user_test').values({
        Name: 'seq_transaction_2',
        Password: 'password',
        CreatedAt: '2024-01-01',
      });
    });

    await res.commit();
    await res2.commit();

    const users = await User.all();
    expect(users.length).to.eq(2);
  });
});

describe('MySql cross-schema whereExists', () => {
  beforeEach(async () => {
    DI.clearCache();

    DI.register(ConnectionConf).as(Configuration);
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');
    await DI.resolve(Orm);
    await db().Connections.get('mysql').truncate('user_test');

    
  });

  after(async () => {
    await db().Connections.get('mysql').disconnect();
    await db().Connections.get('mysql-2').disconnect();
  });

  it('should generate SQL with schema prefix when whereExists uses relation in different schema', async () => {
    const query = User.whereExists('Metadata');
    const compiled = query.toDB() as ICompilerOutput;

    // The outer query should reference the 'test' database
    expect(compiled.expression).to.include('`test`.`user_test`');
    // The EXISTS subquery should reference the 'test-2' database for user_metadata
    expect(compiled.expression).to.include('EXISTS');
    expect(compiled.expression).to.include('`test-2`.`user_metadata`');
  });

  it('should generate SQL with schema prefix when whereExists uses relation with condition', async () => {
    const query = User.whereExists('Metadata', function () {
      this.where('Key', 'some_key');
    });
    const compiled = query.toDB() as ICompilerOutput;

    expect(compiled.expression).to.include('`test`.`user_test`');
    expect(compiled.expression).to.include('EXISTS');
    expect(compiled.expression).to.include('`test-2`.`user_metadata`');
    expect(compiled.expression).to.include('`Key`');
  });
});
