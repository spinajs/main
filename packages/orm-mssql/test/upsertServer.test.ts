/**
 * Upserts against a live SQL Server, in a database of their own ( docker compose --profile test up -d mssql ). Without a
 * server the suite prints one line and is skipped; ORM_TEST_REQUIRE_MSSQL=1 makes a missing server fail it.
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { NotSupported } from '@spinajs/exceptions';
import '@spinajs/log';
import { Connection, InsertBehaviour, Model, ModelBase, Orm, Primary } from '@spinajs/orm';
import { expect } from 'chai';
import _ from 'lodash';
import mssql from 'mssql';
import 'mocha';
import { MsSqlOrmDriver } from '../src/index.js';

const DATABASE = 'spinajs_sx24';
const TABLE = 'upsert_rows';
const WIDE = 'upsert_wide';
const CONNECTION = 'mssql-upsert-server';
const SERVER = { Host: 'localhost', User: 'sa', Password: 'yourStrong(!)Password', Options: { TrustServerCertificate: true, Schema: 'dbo' } };
const DROP_DATABASE = `IF DB_ID(N'${DATABASE}') IS NOT NULL BEGIN ALTER DATABASE [${DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DATABASE}]; END`;

// 1002 bindings per row against MaxBindings 2000: an insert of this table is split into statements of one row
const WIDE_COLUMNS = Array.from({ length: 1000 }, (_v, i) => `C${i}`);
const wideRow = (Id: number, Name: string) => ({ Id, Name, ...Object.fromEntries(WIDE_COLUMNS.map((c) => [c, Id])) });

class UpsertServerConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
        db: { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-mssql', Name: CONNECTION, Database: DATABASE, ...SERVER }] },
      },
      (target: unknown, source: unknown) => (Array.isArray(target) ? target.concat(source) : undefined),
    );
  }
}

@Connection(CONNECTION)
@Model(TABLE)
class UpsertRow extends ModelBase<UpsertRow> {
  @Primary()
  public Id: number;
  public Code: string;
  public Name: string;
}

const run = async (database: string, statement: string) => {
  const pool = await new mssql.ConnectionPool({ server: SERVER.Host, user: SERVER.User, password: SERVER.Password, database, options: { trustServerCertificate: true } }).connect();
  try {
    await pool.request().query(statement);
  } finally {
    await pool.close();
  }
};

const refusal = (statement: PromiseLike<unknown>) =>
  Promise.resolve(statement).then(
    () => undefined,
    (e: unknown) => e,
  );

describe('mssql upsert (live server)', function () {
  this.timeout(60000);

  let orm: Orm | undefined;
  let created = false;

  const connection = () => {
    const driver = orm?.Connections.get(CONNECTION);
    if (!driver) throw new Error(`no connection ${CONNECTION}`);
    return driver;
  };
  const rows = async () => (await UpsertRow.query().orderBy('Id')).map((r) => [r.Id, r.Code, r.Name]);
  const wideRows = async () => (await connection().select().from(WIDE).columns(['Id', 'Name']).orderBy('Id').asRaw<Array<{ Id: number; Name: string }>>()).map((r) => [r.Id, r.Name]);

  before(async function () {
    try {
      await run('master', `${DROP_DATABASE}; CREATE DATABASE [${DATABASE}]`);
      created = true;
    } catch (err) {
      if (process.env.ORM_TEST_REQUIRE_MSSQL === '1') {
        throw err;
      }

      console.warn(`      MSSQL at localhost is unreachable, suite skipped (set ORM_TEST_REQUIRE_MSSQL=1 to fail instead): ${(err as Error).message}`);
      this.skip();
    }

    // before the ORM connects: it reads the table's columns once
    await run(DATABASE, `CREATE TABLE [${TABLE}] ([Id] INT PRIMARY KEY, [Code] NVARCHAR(16) NOT NULL UNIQUE, [Name] NVARCHAR(32) NOT NULL)`);
    await run(DATABASE, `CREATE TABLE [${WIDE}] ([Id] INT PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL, ${WIDE_COLUMNS.map((c) => `[${c}] INT NULL`).join(', ')})`);
    DI.clearCache();
    DI.register(UpsertServerConf).as(Configuration);
    DI.register(MsSqlOrmDriver).as('orm-driver-mssql');
    orm = await DI.resolve(Orm);
  });

  beforeEach(async () => {
    await run(DATABASE, `DELETE FROM [${TABLE}]; INSERT INTO [${TABLE}] ([Id], [Code], [Name]) VALUES (1, 'a', 'one'); DELETE FROM [${WIDE}]; INSERT INTO [${WIDE}] ([Id], [Name]) VALUES (1, 'one')`);
  });

  after(async () => {
    await orm?.dispose();
    if (created) await run('master', DROP_DATABASE);
    DI.unregister(UpsertServerConf);
    DI.clearCache();
  });

  it('refuses an upsert of two rows and writes nothing', async () => {
    const upsert = connection()
      .insert()
      .into(TABLE)
      .values([
        { Id: 1, Code: 'a', Name: 'uno' },
        { Id: 2, Code: 'b', Name: 'two' },
      ]);
    upsert.onDuplicate('Id').update(['Name']);

    expect(await refusal(upsert)).to.be.instanceOf(NotSupported).and.have.property('message').that.contains('one row per statement');
    expect(await rows()).to.deep.eq([[1, 'a', 'one']]);
  });

  it('refuses it also when the insert is split into statements of one row, which updated row 1 twice and lost row 2', async () => {
    const upsert = connection()
      .insert()
      .into(WIDE)
      .values([wideRow(1, 'uno'), wideRow(2, 'two')]);
    upsert.onDuplicate('Id').update(['Name']);

    expect(await refusal(upsert)).to.be.instanceOf(NotSupported).and.have.property('message').that.contains('one row per statement');
    expect(await wideRows()).to.deep.eq([[1, 'one']]);
  });

  it('still updates and inserts one row through Model.insert', async () => {
    await UpsertRow.insert({ Id: 1, Code: 'a', Name: 'uno' }, InsertBehaviour.InsertOrUpdate);
    await UpsertRow.insert({ Id: 2, Code: 'b', Name: 'two' }, InsertBehaviour.InsertOrUpdate);

    expect(await rows()).to.deep.eq([
      [1, 'a', 'uno'],
      [2, 'b', 'two'],
    ]);
  });

  it('still updates and inserts one row through the query builder', async () => {
    for (const row of [
      { Id: 1, Code: 'a', Name: 'uno' },
      { Id: 2, Code: 'b', Name: 'two' },
    ]) {
      await connection().insert().into(TABLE).values(row).onDuplicate('Id').update(['Name']);
    }

    expect(await rows()).to.deep.eq([
      [1, 'a', 'uno'],
      [2, 'b', 'two'],
    ]);
  });
});
