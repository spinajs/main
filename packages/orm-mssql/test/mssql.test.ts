import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import * as _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { MsSqlOrmDriver } from './../src/index';
import { dir, mergeArrays } from './util';
import { IWhereBuilder, MigrationTransactionMode, Orm } from '@spinajs/orm';
import { DI } from '@spinajs/di';
import { User } from './models/User';
import { DateTime } from 'luxon';

const expect = chai.expect;
chai.use(chaiAsPromised);

export class ConnectionConf extends FrameworkConfiguration {
  public async resolveAsync(): Promise<void> {
    await super.resolveAsync();

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
        system: {
          dirs: {
            models: [dir('./models')],
            migrations: [dir('./migrations')],
          },
        },
        db: {
          Migration: {
            Startup: false,
          },
          Connections: [
            {
              Driver: 'orm-driver-mssql',
              Name: 'mssql',
              Host: 'localhost,1992',
              Password: '',
              User: '',
              Database: 'test',
            },
          ],
        },
      },
      mergeArrays,
    );
  }
}

export function db() {
  return DI.get(Orm);
}

describe('MsSql connection test', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    DI.register(MsSqlOrmDriver).as('orm-driver-mssql');
    await DI.resolve(Orm);
  });

  it('Should connect', async () => {
    const result = await db().Connections.get('mssql').ping();
    expect(result).to.equal(true);
  });
});

describe('MsSql driver migration, updates, deletions & inserts', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    DI.register(MsSqlOrmDriver).as('orm-driver-mssql');
    await DI.resolve(Orm);
  });

  it('Should migrate', async () => {
    await db().migrateUp();

    await db().Connections.get('mssql').select().from('user');
    await expect(db().Connections.get('mssql').select().from('notexisted')).to.be.rejected;
  });

  it('Should check if table exists', async () => {
    await db().migrateUp();

    const exists = await db().Connections.get('mssql').schema().tableExists('user');
    const notExists = await db().Connections.get('mssql').schema().tableExists('user2');

    expect(exists).to.eq(true);
    expect(notExists).to.eq(false);
  });

  it('should insert query', async () => {
    await db().migrateUp();
    const id = await db().Connections.get('mssql').insert().into('user').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    const result: User = await db().Connections.get('mssql').select().from('user').first();

    expect(id).to.eq(1);
    expect(result).to.be.not.null;
    expect(result.Id).to.eq(1);
    expect(result.Name).to.eq('test');
  });

  it('should insert or ignore  query', () => {
    const result = db()
      .Connections.get('mssql')
      .insert()
      .into('user')
      .values({
        Name: 'test',
        Password: 'test_password',
        CreatedAt: '2019-10-18',
      })
      .ignore()
      .toDB();

    expect(result.expression).to.eq('INSERT OR IGNORE INTO `user` (`Name`,`Password`,`CreatedAt`) VALUES (?,?,?)');
  });

  it('should delete', async () => {
    await db().migrateUp();
    await db().Connections.get('mssql').insert().into('user').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    await db().Connections.get('mssql').del().from('user').where('id', 1);

    const result = await db().Connections.get('mssql').select().from('user').first();
    expect(result).to.be.undefined;
  });

  it('should update', async () => {
    await db().migrateUp();
    await db().Connections.get('mssql').insert().into('user').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    await db()
      .Connections.get('mssql')
      .update()
      .in('user')
      .update({
        Name: 'test updated',
      })
      .where('id', 1);

    const result: User = await db().Connections.get('mssql').select().from('user').first();
    expect(result).to.be.not.null;
    expect(result.Name).to.eq('test updated');
  });
});

describe('mssql model functions', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    DI.register(MsSqlOrmDriver).as('orm-driver-mssql');
    await DI.resolve(Orm);

    await db().migrateUp();
    await db().reloadTableInfo();
  });

  it('should model create', async () => {
    const user = await User.create({
      Name: 'test',
      Password: 'test_password',
    });

    const result: User = await db().Connections.get('mssql').select().from('user').first();

    expect(result).to.be.not.null;
    expect(result.Id).to.eq(1);
    expect(result.Name).to.eq('test');
    expect(result.Password).to.eq('test_password');

    expect(user).to.be.not.null;
    expect(user.Id).to.eq(1);
    expect(user.Name).to.eq('test');
    expect(user.Password).to.eq('test_password');
  });
});

describe('MsSql queries', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(MsSqlOrmDriver).as('orm-driver-mssql');
    await DI.resolve(Orm);

    await db().migrateUp();
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('should select and sort', async () => {
    await db().Connections.get('mssql').insert().into('user').values({
      Name: 'a',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    await db().Connections.get('mssql').insert().into('user').values({
      Name: 'b',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    const userQuery = User.where(function (this: IWhereBuilder) {
      this.where({ Name: 'a' });
    }).orderBy('Name');

    return expect(userQuery).to.be.fulfilled;
  });

  it('should select to model', async () => {
    await db().Connections.get('mssql').insert().into('user').values({
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
    await db().Connections.get('mssql').insert().into('user').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    const user = await User.get(1);

    expect(user).instanceOf(User);
    expect(user.CreatedAt).instanceof(DateTime);
  });

  it('should run on duplicate', async () => {
    await db().Connections.get('mssql').insert().into('user').values({
      Name: 'test',
      Password: 'test_password',
      CreatedAt: '2019-10-18',
    });

    await User.insert(new User({ Id: 1, Name: 'test2', Password: 'test_password_2', CreatedAt: DateTime.fromFormat('2019-10-19', 'yyyy-MM-dd') }))
      .onDuplicate('Id')
      .update(['Name', 'Password']);

    const all = await User.all();
    const user = await User.get(1);

    expect(user).instanceOf(User);
    expect(user.CreatedAt).instanceof(DateTime);
    expect(user.Name).to.eq('test2');
    expect(user.Password).to.eq('test_password_2');
    expect(all.length).to.eq(1);
  });
});