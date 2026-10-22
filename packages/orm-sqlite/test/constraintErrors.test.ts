import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { ResourceDuplicated } from '@spinajs/exceptions';
import { Connection, ConstraintViolation, Model, ModelBase, Orm, OrmException, Primary, QueryContext, UniqueViolation } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { mapSqliteError, SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

@Connection('sqlite')
@Model('gap_unique')
class GapUnique extends ModelBase {
  @Primary()
  public Id: number;

  public Email: string;
}

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

interface CapturedError {
  message: string;
  kind?: string;
  table?: string;
  columns?: string[];
  inner: { code?: string };
}

async function failure(work: PromiseLike<unknown>): Promise<CapturedError> {
  try {
    await work;
  } catch (err) {
    return err as CapturedError;
  }

  throw new Error('expected the statement to fail');
}

describe('sqlite constraint errors', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('gap_unique', (table) => {
        table.int('Id').primaryKey().autoIncrement();
        table.string('Email').notNull().unique();
      });
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('maps a duplicate primary key on a plain insert to UniqueViolation', async () => {
    await driver().insert().into('gap_unique').values({ Id: 1, Email: 'a@x' });
    const err = await failure(driver().insert().into('gap_unique').values({ Id: 1, Email: 'b@x' }));

    expect(err).to.be.instanceOf(UniqueViolation);
    expect(err).to.be.instanceOf(ResourceDuplicated);
    expect(err.table).to.eq('gap_unique');
    expect(err.columns).to.deep.eq(['Id']);
    expect(err.inner.code).to.eq('SQLITE_CONSTRAINT');
    expect(err.message).to.contain('UNIQUE constraint failed: gap_unique.Id');
  });

  it('maps a duplicate on the RETURNING path of Model.insert to UniqueViolation', async () => {
    await GapUnique.insert({ Email: 'a@x' });
    const err = await failure(GapUnique.insert({ Email: 'a@x' }));

    expect(err).to.be.instanceOf(UniqueViolation);
    expect(err.columns).to.deep.eq(['Email']);
  });

  it('maps a duplicate on update to UniqueViolation', async () => {
    await driver()
      .insert()
      .into('gap_unique')
      .values([
        { Id: 1, Email: 'a@x' },
        { Id: 2, Email: 'b@x' },
      ]);
    const err = await failure(driver().update().in('gap_unique').update({ Email: 'a@x' }).where('Id', 2));

    expect(err).to.be.instanceOf(UniqueViolation);
    expect(err.columns).to.deep.eq(['Email']);
  });

  it('maps NOT NULL to ConstraintViolation, which is not a duplicate', async () => {
    const err = await failure(driver().insert().into('gap_unique').values({ Id: 1, Email: null }));

    expect(err).to.be.instanceOf(ConstraintViolation);
    expect(err).to.be.instanceOf(OrmException);
    expect(err).to.not.be.instanceOf(ResourceDuplicated);
    expect(err.kind).to.eq('not_null');
    expect(err.table).to.eq('gap_unique');
    expect(err.columns).to.deep.eq(['Email']);
    expect(err.inner.code).to.eq('SQLITE_CONSTRAINT');
  });

  it('keeps other failures as OrmException with the sqlite3 error as inner', async () => {
    const err = await failure(driver().insert().into('gap_missing').values({ Id: 1 }));

    expect(err).to.be.instanceOf(OrmException);
    expect(err).to.not.be.instanceOf(ConstraintViolation);
    expect(err.inner.code).to.eq('SQLITE_ERROR');
  });

  it('keeps the sqlite3 error of a failed schema statement', async () => {
    const err = await failure(driver().executeOnDb('CREATE TABLE gap_unique (Id INTEGER)', [], QueryContext.Schema));

    expect(err).to.be.instanceOf(OrmException);
    expect(err.inner.code).to.eq('SQLITE_ERROR');
  });
});

describe('mapSqliteError', () => {
  const at = { Name: 'sqlite' };
  const constraint = (message: string) => Object.assign(new Error(message), { code: 'SQLITE_CONSTRAINT', errno: 19 });

  it('reads the table and columns of a composite unique key', () => {
    const err = mapSqliteError(constraint('SQLITE_CONSTRAINT: UNIQUE constraint failed: members.team_id, members.user_id'), at, 'INSERT', []) as UniqueViolation;

    expect(err).to.be.instanceOf(UniqueViolation);
    expect(err.table).to.eq('members');
    expect(err.columns).to.deep.eq(['team_id', 'user_id']);
  });

  it('names the index of an expression unique index', () => {
    const err = mapSqliteError(constraint("SQLITE_CONSTRAINT: UNIQUE constraint failed: index 'users_email_lower'"), at, 'INSERT', []) as UniqueViolation;

    expect(err).to.be.instanceOf(UniqueViolation);
    expect(err.constraint).to.eq('users_email_lower');
    expect(err.columns).to.eq(undefined);
  });

  it('maps the legacy primary key message to UniqueViolation', () => {
    expect(mapSqliteError(constraint('SQLITE_CONSTRAINT: PRIMARY KEY must be unique'), at, 'INSERT', [])).to.be.instanceOf(UniqueViolation);
  });

  it('maps CHECK and FOREIGN KEY failures to their ConstraintViolation kind', () => {
    const check = mapSqliteError(constraint('SQLITE_CONSTRAINT: CHECK constraint failed: positive_qty'), at, 'INSERT', []) as ConstraintViolation;
    const fk = mapSqliteError(constraint('SQLITE_CONSTRAINT: FOREIGN KEY constraint failed'), at, 'INSERT', []) as ConstraintViolation;

    expect(check.kind).to.eq('check');
    expect(check.constraint).to.eq('positive_qty');
    expect(fk.kind).to.eq('foreign_key');
  });

  it('keeps a non-constraint error as OrmException', () => {
    const err = mapSqliteError(Object.assign(new Error('SQLITE_ERROR: no such table: t'), { code: 'SQLITE_ERROR' }), at, 'SELECT', []);

    expect(err).to.be.instanceOf(OrmException);
    expect(err).to.not.be.instanceOf(ConstraintViolation);
  });
});
