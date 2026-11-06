import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import type { Class } from '@spinajs/di';
import '@spinajs/log';
import { Connection, ConnectionState, Model, ModelBase, Orm, Primary, QueryContext, UniqueViolation } from '@spinajs/orm';
import { createTestApp, type TestApp } from '@spinajs/testing';

import { PgliteOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const CONNECTION = 'pglite-test';
const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };

@Connection(CONNECTION)
@Model('pgl_items')
class PglItem extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

function pgliteConfiguration(connection: Record<string, unknown>): Class<Configuration> {
  return class PgliteTestConfiguration extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      this.set('logger', SILENT);
      this.set('db', { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-pglite', Name: CONNECTION, ...connection }] });
    }
  };
}

interface Booted {
  app: TestApp;
  orm: Orm;
  driver: PgliteOrmDriver;
}

async function boot(connection: Record<string, unknown>): Promise<Booted> {
  const app = await createTestApp({ configuration: pgliteConfiguration(connection), register: (c) => c.register(PgliteOrmDriver).as('orm-driver-pglite') });
  const orm = await app.resolve(Orm);
  return { app, orm, driver: orm.Connections.get(CONNECTION) as PgliteOrmDriver };
}

async function withDriver(connection: Record<string, unknown>, fn: (booted: Booted) => Promise<void>): Promise<void> {
  const booted = await boot(connection);
  try {
    await fn(booted);
  } finally {
    await booted.app.dispose();
  }
}

const select = (driver: PgliteOrmDriver, sql: string, params: unknown[] = []) => driver.executeOnDb(sql, params, QueryContext.Select) as Promise<unknown[]>;

describe('PgliteOrmDriver', function () {
  it('boots as orm-driver-pglite and round-trips a model', async () => {
    await withDriver({}, async ({ orm, driver }) => {
      await driver.schema().createTable('pgl_items', (t) => {
        t.int('Id').primaryKey().autoIncrement();
        t.string('Name');
      });
      await orm.reloadTableInfo();

      await new PglItem({ Name: 'first' }).insert();

      expect((await PglItem.all()).map((i) => i.Name)).to.deep.equal(['first']);
      expect(driver.State).to.equal(ConnectionState.Connected);
    });
  });

  it('runs the session in UTC and in the configured schema, creating it', async () => {
    await withDriver({ Options: { Schema: 'suite_a' } }, async ({ driver }) => {
      expect(await select(driver, 'SHOW TimeZone')).to.deep.equal([{ TimeZone: 'UTC' }]);
      expect(await select(driver, 'SELECT current_schema() AS s')).to.deep.equal([{ s: 'suite_a' }]);
    });
  });

  it('rolls back a failed savepoint and keeps the outer transaction', async () => {
    await withDriver({}, async ({ driver }) => {
      await driver.schema().createTable('pgl_tx', (t) => {
        t.int('Id').primaryKey();
      });

      await driver.transaction(async () => {
        await driver.executeOnDb('INSERT INTO pgl_tx ("Id") VALUES (?)', [1], QueryContext.Insert);
        await driver
          .transaction(async () => {
            await driver.executeOnDb('INSERT INTO pgl_tx ("Id") VALUES (?)', [2], QueryContext.Insert);
            throw new Error('roll back the savepoint');
          })
          .catch(() => undefined);
      });

      expect(await select(driver, 'SELECT "Id" FROM pgl_tx ORDER BY "Id"')).to.deep.equal([{ Id: 1 }]);
    });
  });

  it('queues a second outermost transaction behind the first', async () => {
    await withDriver({}, async ({ driver }) => {
      const order: string[] = [];
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });

      const first = driver.transaction(async () => {
        order.push('first:start');
        await gate;
        order.push('first:end');
      });
      const second = driver.transaction(() => {
        order.push('second');
        return Promise.resolve();
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      open();
      await Promise.all([first, second]);

      expect(order).to.deep.equal(['first:start', 'first:end', 'second']);
      expect(driver.supportedFeatures().concurrentTransactions).to.equal(false);
    });
  });

  it('starts from a dumped data directory given as a file path', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orm-pglite-')), 'template.tar');

    await withDriver({}, async ({ driver }) => {
      await driver.schema().createTable('pgl_seed', (t) => {
        t.int('Id').primaryKey();
      });
      await driver.executeOnDb('INSERT INTO pgl_seed ("Id") VALUES (?)', [7], QueryContext.Insert);
      writeFileSync(path, new Uint8Array(await (await driver.dumpDataDir()).arrayBuffer()));
    });

    await withDriver({ Options: { LoadDataDir: path } }, async ({ driver }) => {
      expect(await select(driver, 'SELECT "Id" FROM pgl_seed')).to.deep.equal([{ Id: 7 }]);
    });
  });

  it('maps a duplicate key to UniqueViolation', async () => {
    await withDriver({}, async ({ driver }) => {
      await driver.schema().createTable('pgl_unique', (t) => {
        t.int('Id').primaryKey();
      });
      await driver.executeOnDb('INSERT INTO pgl_unique ("Id") VALUES (?)', [1], QueryContext.Insert);

      await expect(driver.executeOnDb('INSERT INTO pgl_unique ("Id") VALUES (?)', [1], QueryContext.Insert)).to.be.rejectedWith(UniqueViolation);
    });
  });

  it('reports one session in its pool metrics', async () => {
    await withDriver({}, async ({ driver }) => {
      expect(driver.poolMetrics()).to.deep.equal({ Size: 1, InUse: 0, Waiting: 0 });
    });
  });

  it('closes PGlite on disconnect and never reconnects to a fresh database', async () => {
    await withDriver({}, async ({ driver }) => {
      await driver.disconnect();

      expect(driver.State).to.equal(ConnectionState.Disconnected);
      await expect(select(driver, 'SELECT 1')).to.be.rejected;
      expect(await driver.ping()).to.equal(false);
    });
  });
});
