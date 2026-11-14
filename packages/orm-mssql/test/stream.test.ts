/**
 * Streams against a live SQL Server. Local only: CI runs MSSQL streams in the nightly orm-conformance job.
 *
 *   docker compose --profile test up -d mssql mssql-init
 */
import { DI } from '@spinajs/di';
import { QueryContext, StreamNotSupported } from '@spinajs/orm';
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

async function collect<T>(source: AsyncIterable<T>, stopAfter = Number.POSITIVE_INFINITY): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) {
    out.push(item);
    if (out.length >= stopAfter) {
      break;
    }
  }
  return out;
}

describe('mssql stream', function () {
  this.timeout(60000);

  const table = `stream_t_${randomUUID().slice(0, 8)}`;
  let driver: MsSqlOrmDriver;

  before(async () => {
    driver = await DI.child().resolve(MsSqlOrmDriver, [{ Name: 'mssql-stream', Driver: 'orm-driver-mssql', ...SERVER }]);
    await driver.connect();
    await driver.executeOnDb(`CREATE TABLE [${table}] ([Id] INT PRIMARY KEY, [Name] NVARCHAR(64) NOT NULL)`, [], QueryContext.Schema);
    await driver
      .insert()
      .into(table)
      .values(Array.from({ length: 1000 }, (_, i) => ({ Id: i + 1, Name: `n${i + 1}` })));
  });

  after(async () => {
    await driver?.executeOnDb(`DROP TABLE IF EXISTS [${table}]`, [], QueryContext.Schema);
    await driver?.disconnect();
  });

  it('streams every row in order', async () => {
    const rows = (await collect(driver.select().from(table).order('Id').stream({ batchSize: 100 }))) as Array<{ Id: number }>;

    expect(rows.map((r) => r.Id)).to.deep.equal(Array.from({ length: 1000 }, (_, i) => i + 1));
  });

  it('cancels the request when the loop breaks and keeps the connection usable', async () => {
    await collect(driver.select().from(table).order('Id').stream({ batchSize: 100 }), 150);

    const again = await collect(driver.select().from(table).order('Id').stream({ batchSize: 100 }), 3);
    expect(again).to.have.length(3);
    const one = (await driver.executeOnDb('SELECT 1 AS one', [], QueryContext.Select)) as Array<{ one: number }>;
    expect(one[0].one).to.eq(1);
  });

  it('refuses a raw select inside a transaction: no model, so no keyset page', async () => {
    const loop = driver.transaction(async () => collect(driver.select().from(table).order('Id').stream({ batchSize: 10 }), 5));

    await expect(loop).to.be.rejectedWith(StreamNotSupported);
    const one = (await driver.executeOnDb('SELECT 1 AS one', [], QueryContext.Select)) as Array<{ one: number }>;
    expect(one[0].one).to.eq(1);
  });
});
