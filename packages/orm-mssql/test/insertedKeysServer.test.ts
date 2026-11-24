/**
 * The keys SCOPE_IDENTITY() reports, against a live SQL Server. CI: .github/workflows/orm-mssql.yml.
 *
 *   docker compose --profile test up -d mssql mssql-init
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Connection, InsertBehaviour, InsertQueryBuilder, Model, ModelBase, Orm, Primary, QueryContext, ServerResponseMapper, createQuery } from '@spinajs/orm';
import * as chai from 'chai';
import _ from 'lodash';
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
const IDENTITY = `ik_identity_${SUFFIX}`;
const AUDITED = `ik_audited_${SUFFIX}`;
const AUDIT = `ik_audit_${SUFFIX}`;
const BIG = `ik_big_${SUFFIX}`;
const GUID = `ik_guid_${SUFFIX}`;

class KeysServerConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
        db: { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-mssql', Name: CONNECTION, ...SERVER }] },
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
}

@Connection(CONNECTION)
@Model(BIG)
class LiveBigRow extends ModelBase<LiveBigRow> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection(CONNECTION)
@Model(GUID)
class LiveGuidRow extends ModelBase<LiveGuidRow> {
  @Primary()
  public Id: string;

  public Name: string;
}

describe('mssql inserted keys (live server)', function () {
  this.timeout(60000);

  let orm: Orm | undefined;
  let driver: MsSqlOrmDriver;

  const schema = (stmt: string) => driver.executeOnDb(stmt, [], QueryContext.Schema);
  const dropAll = () => schema(`DROP TABLE IF EXISTS [${IDENTITY}], [${AUDITED}], [${AUDIT}], [${BIG}], [${GUID}]`);
  const idOf = async (table: string, name: string) => ((await driver.executeOnDb(`SELECT [Id] FROM [${table}] WHERE [Name] = ?`, [name], QueryContext.Select)) as Array<{ Id: unknown }>)[0]?.Id;

  /** Runs the insert and asks the connection's mapper for its keys. */
  const keysOf = async (insert: InsertQueryBuilder) => {
    const result: unknown = await insert;
    return insert.Container.resolve(ServerResponseMapper).insertedKeys(result, insert);
  };

  before(async () => {
    DI.clearCache();
    DI.register(KeysServerConf).as(Configuration);
    DI.register(MsSqlOrmDriver).as('orm-driver-mssql');
    orm = await DI.resolve(Orm);
    driver = orm.Connections.get(CONNECTION) as MsSqlOrmDriver;
    await dropAll();
    await schema(`CREATE TABLE [${IDENTITY}] ([Id] INT IDENTITY(1,1) PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL UNIQUE)`);
    await schema(`CREATE TABLE [${AUDIT}] ([Id] INT IDENTITY(500,1) PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL)`);
    await schema(`CREATE TABLE [${AUDITED}] ([Id] INT IDENTITY(1,1) PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL)`);
    await schema(`CREATE TRIGGER [${AUDITED}_trg] ON [${AUDITED}] AFTER INSERT AS INSERT INTO [${AUDIT}] ([Name]) SELECT [Name] FROM inserted UNION ALL SELECT [Name] FROM inserted`);
    await schema(`CREATE TABLE [${BIG}] ([Id] BIGINT IDENTITY(9007199254740993,1) PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL)`);
    await schema(`CREATE TABLE [${GUID}] ([Id] UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY, [Seq] INT IDENTITY(100,1), [Name] NVARCHAR(32) NOT NULL)`);
    await orm.reloadTableInfo();
  });

  after(async () => {
    if (driver) await dropAll();
    await orm?.dispose();
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
    const inserted = await keysOf(createQuery(LiveIdentityRow, InsertQueryBuilder).query.values({ Name: 'ignored' }).orIgnore());
    const skipped = await keysOf(createQuery(LiveIdentityRow, InsertQueryBuilder).query.values({ Name: 'ignored' }).orIgnore());

    expect(inserted).to.deep.eq([{ Id: await idOf(IDENTITY, 'ignored') }]);
    expect(skipped).to.eq(undefined);
  });

  it('reports no key for an upsert, and leaves a model the upsert updated without one', async () => {
    const upsert = () => {
      const { query } = createQuery(LiveIdentityRow, InsertQueryBuilder);
      query.values({ Name: 'merged' }).onDuplicate('Name').update(['Name']);
      return query;
    };
    expect(await keysOf(upsert())).to.eq(undefined);
    // on the same pooled session, SCOPE_IDENTITY() after a MERGE that updated can return this identity of another table
    await driver.insert().into(AUDIT).values({ Name: 'other' });

    expect(await keysOf(upsert())).to.eq(undefined);
    const row = new LiveIdentityRow({ Name: 'merged' });
    await row.insert(InsertBehaviour.InsertOrUpdate);
    expect(row.Id ?? null).to.eq(null);
  });

  it('reports no key for an identity past the safe integer range', async () => {
    expect(await keysOf(createQuery(LiveBigRow, InsertQueryBuilder).query.values({ Name: 'big' }))).to.eq(undefined);
    expect(await idOf(BIG, 'big')).to.eq('9007199254740993');
  });

  it('reports no key when the identity column is not the key', async () => {
    expect(await keysOf(createQuery(LiveGuidRow, InsertQueryBuilder).query.values({ Name: 'guid' }))).to.eq(undefined);
  });

  it('reports no keys for several rows', async () => {
    expect(await keysOf(createQuery(LiveIdentityRow, InsertQueryBuilder).query.values([{ Name: 'many-1' }, { Name: 'many-2' }]))).to.eq(undefined);
  });
});
