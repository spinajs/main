/**
 * The keys an insert outputs, against a live SQL Server. CI: .github/workflows/orm-mssql.yml.
 *
 *   docker compose --profile test up -d mssql mssql-init
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Connection, InsertBehaviour, InsertQueryBuilder, Int64, Model, ModelBase, Orm, Primary, QueryContext, ServerResponseMapper, WriteObserver, createQuery } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, WriteStatement } from '@spinajs/orm';
import * as chai from 'chai';
import _ from 'lodash';
import mssql from 'mssql';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { MsSqlOrmDriver } from '../src/index.js';

const expect = chai.expect;

const SERVER = {
  Host: 'localhost',
  User: 'sa',
  Password: 'yourStrong(!)Password',
  Database: 'test',
  Options: { TrustServerCertificate: true, Schema: 'dbo' },
};

const CONNECTION = 'mssql-inserted-keys-server';
const SUFFIX = randomUUID().slice(0, 8);
const name = (table: string) => `ik_${table}_${SUFFIX}`;
const IDENTITY = name('identity');
const AUDITED = name('audited');
const AUDIT = name('audit');
const BIG = name('big');
const GUID = name('guid');
const NEWID = name('newid');
const SEQUENCE = name('seq');
const SEQ = name('seqkey');
const CHAR = name('char');
const DEC = name('dec');
const PAIR = name('pair');
const CHATTY = name('chatty');
const INSTEAD = name('instead');
const INSTEAD_ID = name('instead_id');
const DOWN = name('down');
const WIDE = name('wide');
const VIEW = name('view');
const INSTEAD_VIEW = name('instead_view');
const TABLES = [IDENTITY, AUDITED, AUDIT, BIG, GUID, NEWID, SEQ, CHAR, DEC, PAIR, CHATTY, INSTEAD, INSTEAD_ID, DOWN, WIDE];

/**
 * Application logins: one denied VIEW DEFINITION, so it sees no trigger in the catalog; one with INSERT and no SELECT; one
 * that may read every column but the key, which an upsert needs.
 */
const HIDDEN_LOGIN = name('hidden');
const INSERT_LOGIN = name('insert');
const KEYLESS_LOGIN = name('keyless');
const LOGINS = [HIDDEN_LOGIN, INSERT_LOGIN, KEYLESS_LOGIN];
const LOGIN_PASSWORD = `Ik_${SUFFIX}!Pass9`;
const HIDDEN = 'mssql-inserted-keys-hidden';
const INSERT_ONLY = 'mssql-inserted-keys-insert-only';
const KEYLESS = 'mssql-inserted-keys-keyless';

class KeysServerConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
        db: {
          StrictTableCheck: false,
          Connections: [
            { Driver: 'orm-driver-mssql', Name: CONNECTION, ...SERVER },
            { Driver: 'orm-driver-mssql', Name: HIDDEN, ...SERVER, User: HIDDEN_LOGIN, Password: LOGIN_PASSWORD },
            { Driver: 'orm-driver-mssql', Name: INSERT_ONLY, ...SERVER, User: INSERT_LOGIN, Password: LOGIN_PASSWORD },
            { Driver: 'orm-driver-mssql', Name: KEYLESS, ...SERVER, User: KEYLESS_LOGIN, Password: LOGIN_PASSWORD },
          ],
        },
      },
      (target: unknown, source: unknown) => (Array.isArray(target) ? target.concat(source) : undefined),
    );
  }
}

@Connection(CONNECTION)
@Model(IDENTITY)
class LiveIdentityRow extends ModelBase<LiveIdentityRow> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection(CONNECTION)
@Model(AUDITED)
class LiveAuditedRow extends ModelBase<LiveAuditedRow> {
  @Primary()
  public Id: number;

  public Name: string;

  public Code: string | null;
}

@Connection(CONNECTION)
@Model(BIG)
class LiveBigRow extends ModelBase<LiveBigRow> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection(CONNECTION)
@Model(BIG)
class LiveBigTextRow extends ModelBase<LiveBigTextRow> {
  @Primary()
  @Int64('string')
  public Id: string;

  public Name: string;
}

@Connection(CONNECTION)
@Model(GUID)
class LiveGuidRow extends ModelBase<LiveGuidRow> {
  @Primary()
  public Id: string;

  public Name: string;
}

@Connection(CONNECTION)
@Model(NEWID)
class LiveNewIdRow extends ModelBase<LiveNewIdRow> {
  @Primary()
  public Id: string;

  public Name: string;
}

@Connection(CONNECTION)
@Model(SEQ)
class LiveSequenceRow extends ModelBase<LiveSequenceRow> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection(CONNECTION)
@Model(CHAR)
class LiveCharRow extends ModelBase<LiveCharRow> {
  @Primary()
  public Id: string;

  public Name: string;
}

@Connection(CONNECTION)
@Model(DEC)
class LiveDecimalRow extends ModelBase<LiveDecimalRow> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection(CONNECTION)
@Model(PAIR)
class LivePairRow extends ModelBase<LivePairRow> {
  @Primary()
  public Tenant: number;

  @Primary()
  public Id: number;

  public Name: string;
}

@Connection(CONNECTION)
@Model(CHATTY)
class LiveChattyRow extends ModelBase<LiveChattyRow> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection(CONNECTION)
@Model(INSTEAD)
class LiveInsteadRow extends ModelBase<LiveInsteadRow> {
  @Primary()
  public Id: string;

  public Name: string;
}

@Connection(CONNECTION)
@Model(INSTEAD_ID)
class LiveInsteadIdentityRow extends ModelBase<LiveInsteadIdentityRow> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection(CONNECTION)
@Model(DOWN)
class LiveDownRow extends ModelBase<LiveDownRow> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection(CONNECTION)
@Model(WIDE)
class LiveWideRow extends ModelBase<LiveWideRow> {
  @Primary()
  public Id: number;

  public Name: string;

  public Code: string;

  public Amount: number;
}

@Connection(CONNECTION)
@Model(VIEW)
class LiveViewRow extends ModelBase<LiveViewRow> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection(CONNECTION)
@Model(INSTEAD_VIEW)
class LiveInsteadViewRow extends ModelBase<LiveInsteadViewRow> {
  @Primary()
  public Id: string;

  public Name: string;
}

const CAPTURED: CapturedWrite[] = [];

class AuditedRecorder extends WriteObserver {
  interest({ model }: WriteStatement): CaptureInterest | undefined {
    return model === LiveAuditedRow ? { columns: ['Name'], transactional: false } : undefined;
  }

  observe(write: CapturedWrite): Promise<void> {
    CAPTURED.push(write);
    return Promise.resolve();
  }
}

describe('mssql inserted keys (live server)', function () {
  this.timeout(60000);

  let orm: Orm | undefined;
  let driver: MsSqlOrmDriver;

  const schema = (stmt: string) => driver.executeOnDb(stmt, [], QueryContext.Schema);
  const dropAll = async () => {
    await schema(`DROP VIEW IF EXISTS [${VIEW}], [${INSTEAD_VIEW}]`);
    await schema(`DROP TABLE IF EXISTS ${TABLES.map((t) => `[${t}]`).join(', ')}`);
    await schema(`DROP SEQUENCE IF EXISTS [${SEQUENCE}]`);
  };
  const rowOf = async (table: string, rowName: string) => ((await driver.executeOnDb(`SELECT * FROM [${table}] WHERE [Name] = ?`, [rowName], QueryContext.Select)) as Array<Record<string, unknown>>)[0];
  const idOf = async (table: string, rowName: string) => (await rowOf(table, rowName))?.Id;

  /** Runs the insert and asks the connection's mapper for its keys. */
  const keysOf = async (insert: InsertQueryBuilder) => {
    const result: unknown = await insert;
    return insert.Container.resolve(ServerResponseMapper).insertedKeys(result, insert);
  };
  const insertOf = (model: typeof ModelBase, rowName: string) => createQuery(model, InsertQueryBuilder).query.values({ Name: rowName });

  /** Runs the compiled insert of a model as another login, and asks the mapper for its keys. */
  const keysAs = async (connection: string, insert: InsertQueryBuilder) => {
    const compiled = insert.toDB();
    const result: unknown = await (orm!.Connections.get(connection) as MsSqlOrmDriver).executeOnDb(compiled.expression ?? '', compiled.bindings ?? [], insert.QueryContext);
    return insert.Container.resolve(ServerResponseMapper).insertedKeys(result, insert);
  };

  const asAdmin = async (statements: string[]) => {
    const pool = await new mssql.ConnectionPool({ server: SERVER.Host, user: SERVER.User, password: SERVER.Password, database: SERVER.Database, options: { trustServerCertificate: true } }).connect();
    try {
      for (const statement of statements) await pool.request().query(statement);
    } finally {
      await pool.close();
    }
  };
  const dropLogins = () =>
    asAdmin(LOGINS.flatMap((login) => [`DROP USER IF EXISTS [${login}]`, `IF SUSER_ID(N'${login}') IS NOT NULL DROP LOGIN [${login}]`]));

  before(async () => {
    // the logins exist before the ORM connects with them
    await asAdmin(
      LOGINS.flatMap((login) => [`CREATE LOGIN [${login}] WITH PASSWORD = '${LOGIN_PASSWORD}', CHECK_POLICY = OFF`, `CREATE USER [${login}] FOR LOGIN [${login}]`]).concat(`DENY VIEW DEFINITION TO [${HIDDEN_LOGIN}]`),
    );
    DI.clearCache();
    DI.register(KeysServerConf).as(Configuration);
    DI.register(MsSqlOrmDriver).as('orm-driver-mssql');
    orm = await DI.resolve(Orm);
    driver = orm.Connections.get(CONNECTION) as MsSqlOrmDriver;
    await dropAll();
    await schema(`CREATE TABLE [${IDENTITY}] ([Id] INT IDENTITY(1,1) PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL UNIQUE)`);
    await schema(`CREATE TABLE [${AUDIT}] ([Id] INT IDENTITY(500,1) PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL)`);
    await schema(`CREATE TABLE [${AUDITED}] ([Id] INT IDENTITY(1,1) PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL, [Code] NVARCHAR(32) NULL)`);
    await schema(`CREATE TRIGGER [${AUDITED}_trg] ON [${AUDITED}] AFTER INSERT, UPDATE AS INSERT INTO [${AUDIT}] ([Name]) SELECT [Name] FROM inserted UNION ALL SELECT [Name] FROM inserted`);
    await schema(`CREATE TABLE [${BIG}] ([Id] BIGINT IDENTITY(9007199254740993,1) PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL)`);
    await schema(`CREATE TABLE [${GUID}] ([Id] UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY, [Seq] INT IDENTITY(100,1), [Name] NVARCHAR(32) NOT NULL)`);
    await schema(`CREATE TABLE [${NEWID}] ([Id] UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL)`);
    await schema(`CREATE SEQUENCE [${SEQUENCE}] AS BIGINT START WITH 1000`);
    await schema(`CREATE TABLE [${SEQ}] ([Id] BIGINT NOT NULL DEFAULT (NEXT VALUE FOR [${SEQUENCE}]) PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL)`);
    await schema(`CREATE TABLE [${CHAR}] ([Id] NVARCHAR(20) NOT NULL DEFAULT (CONCAT(N'k-', NEXT VALUE FOR [${SEQUENCE}])) PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL)`);
    await schema(`CREATE TABLE [${DEC}] ([Id] DECIMAL(12,0) IDENTITY(40,1) PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL)`);
    await schema(`CREATE TABLE [${PAIR}] ([Tenant] INT NOT NULL DEFAULT 7, [Id] INT IDENTITY(1,1), [Name] NVARCHAR(32) NOT NULL, PRIMARY KEY ([Tenant], [Id]))`);
    await schema(`CREATE TABLE [${CHATTY}] ([Id] INT IDENTITY(1,1) PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL)`);
    await schema(`CREATE TRIGGER [${CHATTY}_trg] ON [${CHATTY}] AFTER INSERT AS SELECT 42 AS [TRG]`);
    await schema(`CREATE TABLE [${INSTEAD}] ([Id] UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL)`);
    await schema(`CREATE TRIGGER [${INSTEAD}_trg] ON [${INSTEAD}] INSTEAD OF INSERT AS INSERT INTO [${INSTEAD}] ([Name]) SELECT [Name] FROM inserted`);
    await schema(`CREATE TABLE [${INSTEAD_ID}] ([Id] INT IDENTITY(1,1) PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL)`);
    await schema(`CREATE TRIGGER [${INSTEAD_ID}_trg] ON [${INSTEAD_ID}] INSTEAD OF INSERT AS INSERT INTO [${INSTEAD_ID}] ([Name]) SELECT [Name] FROM inserted`);
    await schema(`CREATE TABLE [${DOWN}] ([Id] INT IDENTITY(0,-1) PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL)`);
    await schema(`CREATE TABLE [${WIDE}] ([Id] INT IDENTITY(1,1) PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL UNIQUE, [Code] NVARCHAR(32) NULL, [Amount] INT NULL)`);
    await schema(`CREATE VIEW [${VIEW}] AS SELECT [Id], [Name] FROM [${IDENTITY}]`);
    await schema(`CREATE VIEW [${INSTEAD_VIEW}] AS SELECT [Id], [Name] FROM [${GUID}]`);
    await schema(`CREATE TRIGGER [${INSTEAD_VIEW}_trg] ON [${INSTEAD_VIEW}] INSTEAD OF INSERT AS INSERT INTO [${GUID}] ([Name]) SELECT [Name] FROM inserted`);
    for (const target of [IDENTITY, GUID, INSTEAD, INSTEAD_ID, INSTEAD_VIEW, DOWN]) await schema(`GRANT SELECT, INSERT ON [${target}] TO [${HIDDEN_LOGIN}]`);
    for (const target of [IDENTITY, NEWID, INSTEAD_ID, WIDE]) await schema(`GRANT INSERT ON [${target}] TO [${INSERT_LOGIN}]`);
    await schema(`GRANT SELECT, INSERT, UPDATE ON [${WIDE}] TO [${KEYLESS_LOGIN}]`);
    await schema(`DENY SELECT ([Id]) ON [${WIDE}] TO [${KEYLESS_LOGIN}]`);
    await orm.reloadTableInfo();
  });

  after(async () => {
    if (driver) await dropAll();
    await orm?.dispose();
    await dropLogins();
    DI.unregister(KeysServerConf);
    DI.clearCache();
  });

  it('backfills the identity key of a model insert', async () => {
    const row = new LiveIdentityRow({ Name: 'plain' });
    await row.insert();

    expect(row.Id).to.be.a('number').and.eq(await idOf(IDENTITY, 'plain'));
  });

  it('backfills the key of a table whose AFTER trigger inserts into another identity table', async () => {
    const row = new LiveAuditedRow({ Name: 'audited' });
    await row.insert();

    expect(row.Id).to.eq(await idOf(AUDITED, 'audited'));
  });

  it('reports the key of an orIgnore() row that was inserted, and nothing for one that was skipped', async () => {
    const inserted = await keysOf(insertOf(LiveIdentityRow, 'ignored').orIgnore());
    const skipped = await keysOf(insertOf(LiveIdentityRow, 'ignored').orIgnore());

    expect(inserted).to.deep.eq([{ Id: await idOf(IDENTITY, 'ignored') }]);
    expect(skipped).to.eq(undefined);
  });

  it('reports the key of the row an upsert inserted, and of the row it updated', async () => {
    const upsert = () => {
      const query = insertOf(LiveIdentityRow, 'merged');
      query.onDuplicate('Name').update(['Name']);
      return query;
    };
    const inserted = await keysOf(upsert());
    // on the same pooled session, SCOPE_IDENTITY() after a MERGE that updated can return this identity of another table
    await driver.insert().into(AUDIT).values({ Name: 'other' });
    const updated = await keysOf(upsert());

    expect(inserted).to.deep.eq([{ Id: await idOf(IDENTITY, 'merged') }]);
    expect(updated).to.deep.eq(inserted);
  });

  it('backfills the key of a model upserted with InsertOrUpdate, whether the row was updated or inserted', async () => {
    const existing = new LiveIdentityRow({ Name: 'upserted' });
    await existing.insert();
    const updated = new LiveIdentityRow({ Name: 'upserted' });
    await updated.insert(InsertBehaviour.InsertOrUpdate);
    const inserted = new LiveIdentityRow({ Name: 'upserted-new' });
    await inserted.insert(InsertBehaviour.InsertOrUpdate);

    expect(updated.Id).to.eq(existing.Id);
    expect(inserted.Id).to.eq(await idOf(IDENTITY, 'upserted-new'));
  });

  it('reports the key of an upsert on a table with an AFTER trigger', async () => {
    const query = insertOf(LiveAuditedRow, 'audited-merge');
    query.onDuplicate('Name').update(['Name']);

    expect(await keysOf(query)).to.deep.eq([{ Id: await idOf(AUDITED, 'audited-merge') }]);
  });

  it('knows the keys a write capture of an upsert reads, when the row carries no conflict value', async () => {
    DI.register(AuditedRecorder).as(WriteObserver);
    try {
      CAPTURED.length = 0;
      const query = createQuery(LiveAuditedRow, InsertQueryBuilder).query.values({ Name: 'captured', Code: null });
      query.onDuplicate('Code').update(['Name']);
      await query;

      expect(CAPTURED).to.have.lengthOf(1);
      expect(CAPTURED[0].unknownKeys).to.eq(false);
      expect(CAPTURED[0].rows.map((r) => r.id)).to.deep.eq([String(await idOf(AUDITED, 'captured'))]);
    } finally {
      DI.unregister(AuditedRecorder);
    }
  });

  it('reports no key for a bigint identity past the safe integer range on a number key, and the exact text on an @Int64("string") key', async () => {
    expect(await keysOf(insertOf(LiveBigRow, 'big'))).to.eq(undefined);
    expect(await idOf(BIG, 'big')).to.eq('9007199254740993');

    expect(await keysOf(insertOf(LiveBigTextRow, 'big-text'))).to.deep.eq([{ Id: '9007199254740994' }]);
  });

  it('reports a NEWID() key on a table whose identity column is another one', async () => {
    expect(await keysOf(insertOf(LiveGuidRow, 'guid'))).to.deep.eq([{ Id: await idOf(GUID, 'guid') }]);
  });

  it('ModelBase.insert() backfills a NEWID() key', async () => {
    const row = new LiveNewIdRow({ Name: 'newid' });
    await row.insert();

    expect(row.Id).to.be.a('string').and.eq(await idOf(NEWID, 'newid'));
  });

  it('reports a sequence default on a bigint key as a number', async () => {
    expect(await keysOf(insertOf(LiveSequenceRow, 'seq'))).to.deep.eq([{ Id: 1000 }]);
  });

  it('reports a character key that a default generates', async () => {
    expect(await keysOf(insertOf(LiveCharRow, 'char'))).to.deep.eq([{ Id: await idOf(CHAR, 'char') }]);
  });

  it('reports a decimal identity key as a number', async () => {
    expect(await keysOf(insertOf(LiveDecimalRow, 'dec'))).to.deep.eq([{ Id: 40 }]);
  });

  it('reports every part of a composite key', async () => {
    expect(await keysOf(insertOf(LivePairRow, 'pair'))).to.deep.eq([{ Tenant: 7, Id: await idOf(PAIR, 'pair') }]);

    const row = new LivePairRow({ Name: 'pair-model' });
    await row.insert();
    expect([row.Tenant, row.Id]).to.deep.eq([7, await idOf(PAIR, 'pair-model')]);
  });

  it('reports identity keys seeded at 0 and counting down', async () => {
    expect(await keysOf(insertOf(LiveDownRow, 'down-0'))).to.deep.eq([{ Id: 0 }]);
    expect(await keysOf(insertOf(LiveDownRow, 'down-1'))).to.deep.eq([{ Id: -1 }]);
  });

  it('gives a login denied VIEW DEFINITION no key behind an INSTEAD OF trigger, and the identity key of an ordinary table', async () => {
    expect(await keysAs(HIDDEN, insertOf(LiveInsteadIdentityRow, 'hidden-instead'))).to.eq(undefined);
    expect(await keysAs(HIDDEN, insertOf(LiveInsteadRow, 'hidden-instead'))).to.eq(undefined);
    expect(await keysAs(HIDDEN, insertOf(LiveInsteadViewRow, 'hidden-view'))).to.eq(undefined);
    expect(await idOf(INSTEAD_ID, 'hidden-instead')).to.be.a('number');

    expect(await keysAs(HIDDEN, insertOf(LiveIdentityRow, 'hidden-plain'))).to.deep.eq([{ Id: await idOf(IDENTITY, 'hidden-plain') }]);
    expect(await keysAs(HIDDEN, insertOf(LiveDownRow, 'hidden-down'))).to.deep.eq([{ Id: await idOf(DOWN, 'hidden-down') }]);
    // nothing but the catalog tells a NEWID() key from one an INSTEAD OF trigger replaced
    expect(await keysAs(HIDDEN, insertOf(LiveGuidRow, 'hidden-guid'))).to.eq(undefined);
  });

  it('inserts as before for a login with INSERT and no SELECT, which keeps the identity key', async () => {
    expect(await keysAs(INSERT_ONLY, insertOf(LiveIdentityRow, 'insert-only'))).to.deep.eq([{ Id: await idOf(IDENTITY, 'insert-only') }]);
    expect(await keysAs(INSERT_ONLY, insertOf(LiveNewIdRow, 'insert-only'))).to.eq(undefined);
    expect(await keysAs(INSERT_ONLY, insertOf(LiveInsteadIdentityRow, 'insert-only'))).to.eq(undefined);
    expect(await idOf(NEWID, 'insert-only')).to.be.a('string');
    expect(await idOf(INSTEAD_ID, 'insert-only')).to.be.a('number');
  });

  it('stores the values a login without SELECT sent once, each in its column', async () => {
    const insert = createQuery(LiveWideRow, InsertQueryBuilder).query.values({ Name: 'wide', Code: 'code', Amount: 42 });

    expect(await keysAs(INSERT_ONLY, insert)).to.deep.eq([{ Id: await idOf(WIDE, 'wide') }]);
    expect(_.pick(await rowOf(WIDE, 'wide'), ['Name', 'Code', 'Amount'])).to.deep.eq({ Name: 'wide', Code: 'code', Amount: 42 });
  });

  it('upserts for a login that may not read the key, without a key, and stores the values it sent', async () => {
    const upsert = (code: string, amount: number) => {
      const query = createQuery(LiveWideRow, InsertQueryBuilder).query.values({ Name: 'wide-merge', Code: code, Amount: amount });
      query.onDuplicate('Name').update(['Code', 'Amount']);
      return query;
    };

    expect(await keysAs(KEYLESS, upsert('first', 1))).to.eq(undefined);
    expect(_.pick(await rowOf(WIDE, 'wide-merge'), ['Code', 'Amount'])).to.deep.eq({ Code: 'first', Amount: 1 });
    expect(await keysAs(KEYLESS, upsert('second', 2))).to.eq(undefined);
    expect(_.pick(await rowOf(WIDE, 'wide-merge'), ['Code', 'Amount'])).to.deep.eq({ Code: 'second', Amount: 2 });
  });

  it('reports the key of a table whose trigger returns a result set', async () => {
    const row = new LiveChattyRow({ Name: 'chatty' });
    await row.insert();

    expect(row.Id).to.eq(await idOf(CHATTY, 'chatty'));
  });

  it('reports no key on a table or a view with an INSTEAD OF INSERT trigger, whose rows are not the ones OUTPUT saw', async () => {
    expect(await keysOf(insertOf(LiveInsteadRow, 'instead'))).to.eq(undefined);
    expect(await keysOf(insertOf(LiveInsteadViewRow, 'instead-view'))).to.eq(undefined);
    expect(await idOf(INSTEAD, 'instead')).to.be.a('string');
  });

  it('reports the key of a row inserted through a view', async () => {
    expect(await keysOf(insertOf(LiveViewRow, 'view'))).to.deep.eq([{ Id: await idOf(IDENTITY, 'view') }]);
  });

  it('reports no keys for several rows', async () => {
    expect(await keysOf(createQuery(LiveIdentityRow, InsertQueryBuilder).query.values([{ Name: 'many-1' }, { Name: 'many-2' }]))).to.eq(undefined);
  });
});
