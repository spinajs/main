/**
 * The row counts writes report against a live SQL Server, on tables with and without triggers. CI: .github/workflows/orm-mssql.yml.
 *
 *   docker compose --profile test up -d mssql mssql-init
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Orm, QueryContext } from '@spinajs/orm';
import * as chai from 'chai';
import _ from 'lodash';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { MsSqlOrmDriver } from '../src/index.js';

const expect = chai.expect;

const CONNECTION = 'mssql-rows-affected-server';
const SUFFIX = randomUUID().slice(0, 8);
const PLAIN = `ra_plain_${SUFFIX}`;
const TRIGGERED = `ra_triggered_${SUFFIX}`;
const QUIET = `ra_quiet_${SUFFIX}`;
const CHATTY = `ra_chatty_${SUFFIX}`;
const LOG = `ra_log_${SUFFIX}`;
const TABLES = [PLAIN, TRIGGERED, QUIET, CHATTY] as const;

class RowsAffectedServerConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
        db: {
          StrictTableCheck: false,
          Connections: [
            {
              Driver: 'orm-driver-mssql',
              Name: CONNECTION,
              Host: 'localhost',
              User: 'sa',
              Password: 'yourStrong(!)Password',
              Database: 'test',
              Options: { TrustServerCertificate: true, Schema: 'dbo' },
            },
          ],
        },
      },
      (target: unknown, source: unknown) => (Array.isArray(target) ? target.concat(source) : undefined),
    );
  }
}

describe('mssql rows affected (live server)', function () {
  this.timeout(60000);

  let orm: Orm | undefined;
  let driver: MsSqlOrmDriver;

  const schema = (stmt: string) => driver.executeOnDb(stmt, [], QueryContext.Schema);
  const dropAll = () => schema(`DROP TABLE IF EXISTS ${[...TABLES, LOG].map((t) => `[${t}]`).join(', ')}`);
  const countOf = (result: unknown) => (result as { RowsAffected?: unknown }).RowsAffected;

  before(async () => {
    DI.clearCache();
    DI.register(RowsAffectedServerConf).as(Configuration);
    DI.register(MsSqlOrmDriver).as('orm-driver-mssql');
    orm = await DI.resolve(Orm);
    driver = orm.Connections.get(CONNECTION) as MsSqlOrmDriver;
    await dropAll();
    await schema(`CREATE TABLE [${LOG}] ([Id] INT IDENTITY(500,1) PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL, [Hits] INT NOT NULL DEFAULT 0)`);
    for (const table of TABLES) {
      await schema(`CREATE TABLE [${table}] ([Id] INT IDENTITY(1,1) PRIMARY KEY, [Name] NVARCHAR(32) NOT NULL)`);
    }
    const logTwice = `INSERT INTO [${LOG}] ([Name]) SELECT [Name] FROM inserted UNION ALL SELECT N'again' FROM inserted UNION ALL SELECT [Name] FROM deleted UNION ALL SELECT N'again' FROM deleted`;
    await schema(`CREATE TRIGGER [${TRIGGERED}_trg] ON [${TRIGGERED}] AFTER INSERT, UPDATE, DELETE AS BEGIN ${logTwice}; UPDATE [${LOG}] SET [Hits] = [Hits] + 1; END`);
    await schema(`CREATE TRIGGER [${QUIET}_trg] ON [${QUIET}] AFTER INSERT, UPDATE, DELETE AS BEGIN SET NOCOUNT ON; ${logTwice}; UPDATE [${LOG}] SET [Hits] = [Hits] + 1; END`);
    await schema(`CREATE TRIGGER [${CHATTY}_trg] ON [${CHATTY}] AFTER INSERT, UPDATE, DELETE AS BEGIN ${logTwice}; SELECT COUNT(*) AS [Logged] FROM [${LOG}]; END`);
  });

  after(async () => {
    if (driver) await dropAll();
    await orm?.dispose();
    DI.unregister(RowsAffectedServerConf);
    DI.clearCache();
  });

  for (const table of TABLES) {
    describe(table.split('_')[1], () => {
      it('an insert of one row reports 1', async () => {
        expect(countOf(await driver.insert().into(table).values({ Name: 'one' }))).to.eq(1);
      });

      it('an insert of three rows reports 3', async () => {
        expect(countOf(await driver.insert().into(table).values([{ Name: 'many' }, { Name: 'many' }, { Name: 'many' }]))).to.eq(3);
      });

      it('an update reports the rows it changed', async () => {
        expect(countOf(await driver.update().in(table).update({ Name: 'changed' }).where('Name', 'many'))).to.eq(3);
        expect(countOf(await driver.update().in(table).update({ Name: 'none' }).where('Name', 'missing'))).to.eq(0);
      });

      it('a delete reports the rows it removed', async () => {
        expect(countOf(await driver.del().from(table).where('Name', 'changed'))).to.eq(3);
        expect(countOf(await driver.del().from(table).where('Name', 'missing'))).to.eq(0);
      });
    });
  }
});
