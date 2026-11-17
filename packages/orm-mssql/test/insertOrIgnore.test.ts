/**
 * `orIgnore()` against a live SQL Server. Local only, like the other server-backed files here:
 *
 *   docker compose --profile test up -d mssql mssql-init
 */
import { DI } from '@spinajs/di';
import { ConstraintViolation, OrmException, QueryContext, UniqueViolation } from '@spinajs/orm';
import '@spinajs/log';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { MsSqlOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const SERVER = {
  Host: 'localhost',
  User: 'sa',
  Password: 'yourStrong(!)Password',
  Database: 'test',
  Options: { TrustServerCertificate: true },
};

type Row = { Code: string; Label: string };

describe('MsSql insert or ignore', function () {
  this.timeout(60000);

  const table = `insert_ignore_${randomUUID().slice(0, 8)}`;
  let driver: MsSqlOrmDriver;

  const rows = async (): Promise<Row[]> => driver.select<Row[]>().from(table).columns(['Code', 'Label']).orderBy('Id');

  before(async () => {
    driver = await DI.child().resolve(MsSqlOrmDriver, [{ Name: 'mssql-insert-ignore', Driver: 'orm-driver-mssql', ...SERVER }]);
    await driver.connect();
  });

  beforeEach(async () => {
    await driver.executeOnDb(`DROP TABLE IF EXISTS [${table}]`, [], QueryContext.Schema);
    await driver.executeOnDb(`CREATE TABLE [${table}] ([Id] INT IDENTITY(1,1) PRIMARY KEY, [Code] NVARCHAR(32) NOT NULL UNIQUE, [Label] NVARCHAR(32) NOT NULL)`, [], QueryContext.Schema);
  });

  after(async () => {
    await driver?.executeOnDb(`DROP TABLE IF EXISTS [${table}]`, [], QueryContext.Schema);
    await driver?.disconnect();
  });

  it('inserts a new row and reports it', async () => {
    const result = await driver.insert().into(table).values({ Code: 'a', Label: 'first' }).orIgnore();

    expect(result.RowsAffected).to.eq(1);
    expect(result.LastInsertId).to.be.greaterThan(0);
  });

  it('leaves a duplicate under a unique constraint alone and reports no row', async () => {
    await driver.insert().into(table).values({ Code: 'a', Label: 'first' }).orIgnore();
    const result = await driver.insert().into(table).values({ Code: 'a', Label: 'second' }).orIgnore();

    expect(result.RowsAffected).to.eq(0);
    expect(result.LastInsertId).to.eq(0);
    expect(await rows()).to.deep.eq([{ Code: 'a', Label: 'first' }]);
  });

  it('leaves a duplicate under a unique index alone', async () => {
    await driver.executeOnDb(`CREATE UNIQUE INDEX [ux_label] ON [${table}] ([Label])`, [], QueryContext.Schema);
    await driver.insert().into(table).values({ Code: 'a', Label: 'first' });
    const result = await driver.insert().into(table).values({ Code: 'b', Label: 'first' }).orIgnore();

    expect(result.RowsAffected).to.eq(0);
    expect(await rows()).to.deep.eq([{ Code: 'a', Label: 'first' }]);
  });

  it('keeps the surrounding transaction usable after an ignored duplicate', async () => {
    await driver.insert().into(table).values({ Code: 'a', Label: 'first' });
    await driver.transaction(async () => {
      const ignored = await driver.insert().into(table).values({ Code: 'a', Label: 'second' }).orIgnore();
      expect(ignored.RowsAffected).to.eq(0);
      await driver.insert().into(table).values({ Code: 'b', Label: 'third' });
    });

    expect(await rows()).to.deep.eq([
      { Code: 'a', Label: 'first' },
      { Code: 'b', Label: 'third' },
    ]);
  });

  it('still fails on an error that is not a duplicate key', async () => {
    await expect(driver.insert().into(table).values({ Code: 'c', Label: null }).orIgnore()).to.be.rejectedWith(ConstraintViolation);
    expect(await rows()).to.deep.eq([]);
  });

  it('refuses several rows in one statement', () => {
    const compile = () =>
      driver
        .insert()
        .into(table)
        .values([
          { Code: 'a', Label: 'first' },
          { Code: 'b', Label: 'second' },
        ])
        .orIgnore()
        .toDB();

    expect(compile).to.throw(OrmException, /one row/);
  });

  it('still throws for a duplicate key without orIgnore()', async () => {
    await driver.insert().into(table).values({ Code: 'a', Label: 'first' });

    await expect(driver.insert().into(table).values({ Code: 'a', Label: 'second' })).to.be.rejectedWith(UniqueViolation);
  });
});
