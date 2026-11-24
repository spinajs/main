/**
 * Column defaults read by tableInfo(), against a live SQL Server. CI: .github/workflows/orm-mssql.yml.
 *
 *   docker compose --profile test up -d mssql mssql-init
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Connection, Model, ModelBase, Orm, Primary, QueryContext } from '@spinajs/orm';
import * as chai from 'chai';
import _ from 'lodash';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { MsSqlOrmDriver } from '../src/index.js';

const expect = chai.expect;

const CONNECTION = 'mssql-column-defaults-server';
const TABLE = `cd_defaults_${randomUUID().slice(0, 8)}`;

class DefaultsServerConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
        db: {
          StrictTableCheck: false,
          Connections: [{ Driver: 'orm-driver-mssql', Name: CONNECTION, Host: 'localhost', User: 'sa', Password: 'yourStrong(!)Password', Database: 'test', Options: { TrustServerCertificate: true, Schema: 'dbo' } }],
        },
      },
      (target: unknown, source: unknown) => (Array.isArray(target) ? target.concat(source) : undefined),
    );
  }
}

@Connection(CONNECTION)
@Model(TABLE)
class Defaulted extends ModelBase<Defaulted> {
  @Primary()
  public Id: number;

  public Zero: number;

  public Letter: string;

  public Quoted: string;

  public Flag: boolean;

  public Maybe: string | null;

  public At: unknown;

  public Token: string;
}

describe('mssql column defaults (live server)', function () {
  this.timeout(60000);

  let orm: Orm | undefined;
  let driver: MsSqlOrmDriver;

  const schema = (stmt: string) => driver.executeOnDb(stmt, [], QueryContext.Schema);

  before(async () => {
    DI.clearCache();
    DI.register(DefaultsServerConf).as(Configuration);
    DI.register(MsSqlOrmDriver).as('orm-driver-mssql');
    orm = await DI.resolve(Orm);
    driver = orm.Connections.get(CONNECTION) as MsSqlOrmDriver;
    await schema(`DROP TABLE IF EXISTS [${TABLE}]`);
    await schema(
      `CREATE TABLE [${TABLE}] ([Id] INT IDENTITY(1,1) PRIMARY KEY, [Zero] INT NOT NULL DEFAULT 0, [Letter] NVARCHAR(8) NOT NULL DEFAULT 'a', ` +
        `[Quoted] NVARCHAR(8) NOT NULL DEFAULT N'it''s', [Flag] BIT NOT NULL DEFAULT 1, [Maybe] NVARCHAR(8) NULL DEFAULT NULL, ` +
        `[At] DATETIME2 NULL DEFAULT (getdate()), [Token] UNIQUEIDENTIFIER NULL DEFAULT (newid()))`,
    );
    await orm.reloadTableInfo();
  });

  after(async () => {
    if (driver) await schema(`DROP TABLE IF EXISTS [${TABLE}]`);
    await orm?.dispose();
    DI.unregister(DefaultsServerConf);
    DI.clearCache();
  });

  it('gives a new model the values of literal defaults and leaves expression defaults unset', () => {
    const row = new Defaulted();

    expect(_.pick(row, ['Zero', 'Letter', 'Quoted', 'Flag', 'Maybe'])).to.deep.eq({ Zero: 0, Letter: 'a', Quoted: "it's", Flag: true, Maybe: null });
    expect(row.At).to.eq(undefined);
    expect(row.Token).to.eq(undefined);
  });

  it('inserts a new model, and the server fills the expression defaults', async () => {
    const row = new Defaulted();
    await row.insert();

    const [stored] = (await driver.executeOnDb(`SELECT * FROM [${TABLE}] WHERE [Id] = ?`, [row.Id], QueryContext.Select)) as Array<Record<string, unknown>>;
    expect(_.pick(stored, ['Zero', 'Letter', 'Quoted', 'Flag', 'Maybe'])).to.deep.eq({ Zero: 0, Letter: 'a', Quoted: "it's", Flag: true, Maybe: null });
    expect(stored.At).to.be.instanceOf(Date);
    expect(stored.Token).to.be.a('string').with.lengthOf(36);
  });
});
