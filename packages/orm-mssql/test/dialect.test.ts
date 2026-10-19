import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { InvalidArgument, MethodNotImplemented, NotSupported } from '@spinajs/exceptions';
import { DatetimeValueConverter, ICompilerOutput, IdentifierQuoter, InSetStatement, OrmException, QueryContext, RawQuery, SchemaQueryBuilder, ServerResponseMapper } from '@spinajs/orm';
import { DateTime } from 'luxon';
import mssql from 'mssql';

import { MsSqlOrmDriver } from '../src/index.js';
import { MsSqlInSetStatement } from '../src/statements.js';

/**
 * MSSQL's side of the dialect contract.
 *
 * Runs without a database for the same reason the MySQL one does: resolving the
 * driver is what registers its dialect classes, and a statement can be built and
 * read back without a server to execute it.
 */
describe('mssql dialect', function () {
  this.timeout(15000);

  let driver: MsSqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-dialect-test', Driver: 'orm-driver-mssql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  /**
   * Brackets, not backticks. This driver imported the shared BACKTICK helper directly,
   * so every identifier a shared compiler produced for SQL Server came out as
   * `` `table` `` — invalid T-SQL that no compiler override could fix, because
   * shadowing a compiler does not shadow a function it calls internally.
   */
  it('quotes with brackets', () => {
    const quoter = driver.Container.resolve<IdentifierQuoter>(IdentifierQuoter);

    expect(quoter.quote('Role')).to.eq('[Role]');
    expect(quoter.quote('we]rd')).to.eq('[we]]rd]');
    expect(quoter.quoteQualified('dbo.users')).to.eq('[dbo].[users]');
  });

  /**
   * `CREATE TABLE ... LIKE` and `WITH RECURSIVE` are not T-SQL. This driver registers
   * neither, so they fail instead of reaching SQL Server as MySQL syntax.
   */
  it('leaves the abstractions it has no T-SQL for unregistered', () => {
    for (const abstraction of ['TableCloneQueryCompiler', 'RecursiveQueryCompiler']) {
      expect(driver.Container.hasRegistered(abstraction), `${abstraction} must not be inherited from the MySQL-flavoured base`).to.eq(false);
    }
  });

  it('refuses scheduled events, SQL Server Agent is not implemented', () => {
    const schema = driver.Container.resolve(SchemaQueryBuilder, [driver]);

    expect(driver.supportedFeatures().events).to.eq(false);
    expect(() => schema.createEvent('e', (event) => event.every(1, 'DAY').do(new RawQuery('SELECT 1'))).toDB()).to.throw(MethodNotImplemented, 'orm-driver-mssql has no native scheduled events');
    expect(() => schema.dropEvent('e').toDB()).to.throw(MethodNotImplemented, 'orm-driver-mssql has no native scheduled events');
  });

  describe('set membership', () => {
    const statement = (values: any[], not = false) => driver.Container.resolve<InSetStatement>(InSetStatement, ['Role', values, not, undefined]);

    it('uses the mssql implementation', () => {
      expect(statement(['admin'])).to.be.instanceOf(MsSqlInSetStatement);
    });

    /**
     * CHARINDEX with `+` concatenation. MSSQL has neither `FIND_IN_SET` — which it
     * used to inherit and fail on — nor the `||` operator SQLite uses.
     */
    it('compiles to CHARINDEX', () => {
      const { Statements, Bindings } = statement(['admin']).build();

      expect(Statements[0]).to.contain('CHARINDEX(?');
      expect(Statements[0]).to.not.contain('FIND_IN_SET');
      expect(Bindings).to.deep.eq([',admin,']);
    });

    it('ORs several values together', () => {
      const { Statements, Bindings } = statement(['admin', 'user']).build();

      expect(Statements[0].match(/CHARINDEX/g)).to.have.lengthOf(2);
      expect(Statements[0]).to.match(/^\(\(.*\) OR \(.*\)\)$/);
      expect(Bindings).to.deep.eq([',admin,', ',user,']);
    });

    it('ANDs the negation of every value', () => {
      const { Statements } = statement(['admin', 'user'], true).build();

      expect(Statements[0]).to.match(/^\(NOT \(.*\) AND NOT \(.*\)\)$/);
    });

    it('matches nothing for an empty value list, and everything for its negation', () => {
      expect(statement([]).build().Statements[0]).to.eq('(1 = 0)');
      expect(statement([], true).build().Statements[0]).to.eq('(1 = 1)');
    });

    it('refuses a value containing the set delimiter', () => {
      expect(() => statement(['admin,user']).build()).to.throw(InvalidArgument, /delimiter/);
    });
  });
});

describe('mssql statements', function () {
  this.timeout(15000);

  let driver: MsSqlOrmDriver;
  const sql = (q: { toDB(): unknown }) => {
    const out = q.toDB() as ICompilerOutput | ICompilerOutput[];
    return (Array.isArray(out) ? out[0] : out) as ICompilerOutput;
  };
  const schema = () => driver.Container.resolve(SchemaQueryBuilder, [driver]);

  beforeEach(async () => {
    driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-statements-test', Driver: 'orm-driver-mssql', Database: 'test' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('maps an insert response', () => {
    const mapper = driver.Container.resolve(ServerResponseMapper);

    expect(mapper.read({ RowsAffected: 1, LastInsertId: 7, Returning: [] })).to.deep.eq({ RowsAffected: 1, LastInsertId: 7, Returning: [] });
    expect(mapper.read([{ ID: 9 }]).LastInsertId).to.eq(9);
  });

  it('runs several parameterized statements in one transaction', async () => {
    const request = () => Object.assign(new mssql.Request(), { query: () => Promise.resolve({ recordset: [], rowsAffected: [0] }) });
    const transaction = { begin: () => Promise.resolve(), commit: () => Promise.resolve(), rollback: () => Promise.resolve(), request };
    (driver as any)._connectionPool = { transaction: () => transaction, request };

    await driver.transaction(async () => {
      await driver.executeOnDb('SELECT ?', [1], QueryContext.Select);
      await driver.executeOnDb('SELECT ?', [2], QueryContext.Select);
    });
  });

  it('opens a pool of its own per connection, on the configured port and database', async () => {
    const queries: string[] = [];
    const proto = mssql.ConnectionPool.prototype as any;
    const { connect, request } = proto;
    proto.connect = function () {
      return Promise.resolve(this);
    };
    proto.request = () => ({ input() {}, query: (q: string) => (queries.push(q), Promise.resolve({ recordset: [], rowsAffected: [0] })) });

    try {
      const a = await DI.resolve(MsSqlOrmDriver, [{ Name: 'a', Driver: 'orm-driver-mssql', Host: 'h', Port: 14330, Database: 'my db' } as any]);
      const b = await DI.resolve(MsSqlOrmDriver, [{ Name: 'b', Driver: 'orm-driver-mssql', Host: 'h', Database: 'other' } as any]);
      await a.connect();
      await b.connect();

      expect((a as any)._connectionPool).to.not.eq((b as any)._connectionPool);
      expect((a as any)._connectionPool.config.port).to.eq(14330);
      expect(queries).to.include('USE [my db]');
    } finally {
      proto.connect = connect;
      proto.request = request;
    }
  });

  it('reflects nullability, identity and length of a column', async () => {
    driver.executeOnDb = (stmt: string) =>
      Promise.resolve(stmt.includes('INFORMATION_SCHEMA.COLUMNS') ? [{ COLUMN_NAME: 'Name', DATA_TYPE: 'nvarchar', IS_NULLABLE: 'NO', CHARACTER_MAXIMUM_LENGTH: 50, IS_IDENTITY: 0 }, { COLUMN_NAME: 'Id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', CHARACTER_MAXIMUM_LENGTH: null, IS_IDENTITY: 1 }] : []);

    const [name, id] = await driver.tableInfo('users');

    expect(name).to.include({ Nullable: false, AutoIncrement: false, MaxLength: 50 });
    expect(id).to.include({ AutoIncrement: true });
  });

  it('upserts from the inserted values, on every unique column, without a model', () => {
    const out = sql(driver.insert().into('users').values({ Email: 'e', Tenant: 't', Name: 'n' }).onDuplicate(['Email', 'Tenant']).update(['Name']));

    expect(out.expression).to.contain('USING (SELECT ? AS [Email], ? AS [Tenant]) AS source ON (target.[Email] = source.[Email] AND target.[Tenant] = source.[Tenant])');
    expect(out.bindings).to.deep.eq(['e', 't', 'n', 'e', 't', 'n']);
  });

  it('refuses insert or replace', () => {
    expect(() => driver.insert().into('users').values({ Name: 'n' }).orReplace().toDB()).to.throw(OrmException);
  });

  it('writes a limited delete as DELETE TOP (n)', () => {
    expect(sql(driver.del().from('users').take(5)).expression).to.contain('DELETE TOP (5) FROM');
  });

  it('sorts by every column and pages without an explicit sort', () => {
    expect(sql(driver.select().from('users').orderBy('A').orderByDescending('B')).expression).to.contain('ORDER BY [A] ASC, [B] DESC');

    const skipped = sql(driver.select().from('users').skip(10));
    expect(skipped.expression).to.match(/ORDER BY \(SELECT NULL\) OFFSET \? ROWS$/);
    expect(skipped.bindings).to.deep.eq([10]);
  });

  it('creates a table in T-SQL', () => {
    const out = sql(
      schema()
        .createTable('users', (t) => {
          t.int('Id').primaryKey().autoIncrement();
          t.string('Email').unique();
          t.boolean('Active').default().value(1);
          t.json('Data');
          t.dateTime('Born').default().date();
        })
        .ifExists(),
    ).expression as string;

    expect(out).to.match(/^IF OBJECT_ID\(N'\[users\]', N'U'\) IS NULL CREATE TABLE \[users\]/);
    expect(out.match(/UNIQUE/g)).to.have.lengthOf(1);
    expect(out).to.contain('[Active] BIT DEFAULT 1');
    expect(out).to.contain('[Data] NVARCHAR(MAX)');
    expect(out).to.contain('DEFAULT (CAST(GETDATE() AS DATE))');
  });

  it('refuses table features it has no T-SQL for', () => {
    expect(() => sql(schema().createTable('t', (t) => t.int('Id')).temporary())).to.throw(NotSupported);
    expect(() => sql(schema().createTable('t', (t) => t.int('Id')).trackHistory())).to.throw(MethodNotImplemented);
    expect(() => sql(schema().createTable('t', (t) => t.string('Name').charset('utf8')))).to.throw(NotSupported);
  });

  it('alters a table in T-SQL', () => {
    const out = schema()
      .alterTable('users', (t) => {
        t.string('Email', 64).notNull();
        t.string('SessionId', 64).notNull().modify();
        t.int('UserId').modify();
        t.string('Old').rename("N'ew");
        t.dropColumn('Gone');
        t.rename('people');
      })
      .toDB()
      .map((o) => o.expression);

    expect(out).to.deep.eq([
      'ALTER TABLE [users] DROP COLUMN [Gone]',
      'ALTER TABLE [users] ADD [Email] VARCHAR(64) NOT NULL',
      'ALTER TABLE [users] ALTER COLUMN [SessionId] VARCHAR(64) NOT NULL',
      'ALTER TABLE [users] ALTER COLUMN [UserId] INT NULL',
      "EXEC sp_rename N'[users].[Old]', N'N''ew', N'COLUMN'",
      "EXEC sp_rename N'[users]', N'people'",
    ]);

    const other = schema().alterTable('users', (t) => t.rename('people')).database('other');
    expect(other.toDB()[0].expression).to.eq("EXEC [other].sys.sp_rename N'[users]', N'people'");
  });

  it('refuses column alterations it has no T-SQL for', () => {
    expect(() => schema().alterTable('t', (t) => t.int('A').after('B')).toDB()).to.throw(NotSupported);
    expect(() => schema().alterTable('t', (t) => t.int('A').modify().default().value(1)).toDB()).to.throw(NotSupported);
  });

  it('writes a DateTime in UTC and keeps a string', () => {
    const converter = driver.Container.resolve<DatetimeValueConverter>(DatetimeValueConverter);

    expect(converter.toDB(DateTime.fromISO('2024-05-01T10:30:00', { zone: 'UTC+2' }), null as any, null as any)).to.eq('2024-05-01T08:30:00.000');
    expect(converter.toDB('2024-05-01' as any, null as any, null as any)).to.eq('2024-05-01');
  });
});
