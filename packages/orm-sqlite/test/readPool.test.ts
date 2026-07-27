/* eslint-disable @typescript-eslint/no-floating-promises */
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import '@spinajs/log';
import { SqliteOrmDriver } from './../src/index.js';
import { ConnectionConf } from './common.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const DB_FILE = join(process.cwd(), 'test', 'read-pool.sqlite');

function removeDbFiles() {
  // A journal leaves -wal / -shm siblings behind; removing only the main file leaves stale state.
  [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`].forEach((f) => {
    if (existsSync(f)) {
      unlinkSync(f);
    }
  });
}

/**
 * Builds the driver directly rather than going through `Orm`.
 *
 * Resolving `Orm` runs `reloadTableInfo()`, which writes column descriptors into module-level
 * model metadata that `DI.clearCache()` does not reset — so a suite that resolves `Orm` against
 * its own database perturbs every later suite in this package. The read pool is a driver
 * concern, so there is nothing to gain from the round trip.
 */
async function makeDriver(options: Record<string, unknown>): Promise<SqliteOrmDriver> {
  const d = await DI.resolve<SqliteOrmDriver>('orm-driver-sqlite', [{ Driver: 'orm-driver-sqlite', Name: 'readpool', ...options }]);
  await d.connect();
  return d;
}

describe('Sqlite - read handle pool', function () {
  this.timeout(20000);

  let driver: SqliteOrmDriver;

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    removeDbFiles();
    driver = await makeDriver({ Filename: DB_FILE, Pool: { Max: 3 } });
  });

  afterEach(async () => {
    await driver.disconnect();
    removeDbFiles();
  });

  it('opens Pool.Max - 1 read handles alongside the writer', () => {
    expect((driver as any).ReadPool).to.have.length(2);
  });

  it('reports the writer plus every read handle in poolMetrics', () => {
    expect(driver.poolMetrics()).to.deep.equal({ Size: 3, InUse: 0, Waiting: 0 });
  });

  it('runs concurrent selects without serializing on the writer handle', async () => {
    await driver.executeOnDb('CREATE TABLE rp (Id INTEGER PRIMARY KEY, V TEXT)', [], QueryContext.Schema);
    await driver.executeOnDb('INSERT INTO rp (V) VALUES (?)', ['a'], QueryContext.Insert);

    const results = await Promise.all([
      driver.executeOnDb('SELECT * FROM rp', [], QueryContext.Select),
      driver.executeOnDb('SELECT * FROM rp', [], QueryContext.Select),
      driver.executeOnDb('SELECT * FROM rp', [], QueryContext.Select),
    ]);

    results.forEach((r) => expect(r).to.have.length(1));
  });

  it('sends everything that is not a plain select to the writer handle', () => {
    const writer = (driver as any).Db;

    [QueryContext.Insert, QueryContext.Update, QueryContext.Delete, QueryContext.Schema, QueryContext.Transaction, QueryContext.Upsert, QueryContext.InsertReturning].forEach((ctx) => {
      expect((driver as any).handleFor(ctx)).to.equal(writer);
    });
  });

  it('keeps a transaction on the writer handle even for selects', async () => {
    await driver.executeOnDb('CREATE TABLE rp3 (Id INTEGER PRIMARY KEY)', [], QueryContext.Schema);

    await driver.transaction(async () => {
      expect((driver as any).handleFor(QueryContext.Select)).to.equal((driver as any).Db);
    });
  });

  it('round-robins selects across the read handles and never the writer', () => {
    const chosen = [1, 2, 3, 4].map(() => (driver as any).handleFor(QueryContext.Select));

    expect(new Set(chosen).size).to.equal(2);
    expect(chosen[0]).to.equal(chosen[2]);
    expect(chosen[1]).to.equal(chosen[3]);
    expect(chosen).to.not.include((driver as any).Db);
  });

  it('a read handle sees committed writes made on the writer', async () => {
    await driver.executeOnDb('CREATE TABLE rp4 (Id INTEGER PRIMARY KEY, V TEXT)', [], QueryContext.Schema);
    await driver.executeOnDb('INSERT INTO rp4 (V) VALUES (?)', ['written-on-writer'], QueryContext.Insert);

    const rows = (await driver.executeOnDb('SELECT V FROM rp4', [], QueryContext.Select)) as Array<{ V: string }>;

    expect(rows.map((r) => r.V)).to.deep.equal(['written-on-writer']);
  });

  it('Pool.Max of 1 opens no read handles', async () => {
    const d = await makeDriver({ Filename: DB_FILE, Pool: { Max: 1 } });

    expect((d as any).ReadPool).to.have.length(0);
    expect((d as any).handleFor(QueryContext.Select)).to.equal((d as any).Db);

    await d.disconnect();
  });

  it('an in-memory database never opens read handles', async () => {
    // :memory: gives every handle its OWN private database, so a read pool would query empty
    // databases. The driver must refuse to build one.
    const d = await makeDriver({ Filename: ':memory:', Pool: { Max: 4 } });

    expect((d as any).ReadPool).to.have.length(0);
    expect((d as any).handleFor(QueryContext.Select)).to.equal((d as any).Db);

    await d.disconnect();
  });

  it('disconnect closes every read handle', async () => {
    const d = await makeDriver({ Filename: DB_FILE, Pool: { Max: 3 } });
    expect((d as any).ReadPool).to.have.length(2);

    await d.disconnect();

    expect((d as any).ReadPool).to.have.length(0);
    expect(d.poolMetrics()).to.deep.equal({ Size: 0, InUse: 0, Waiting: 0 });
  });
});
