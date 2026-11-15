import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { existsSync } from 'node:fs';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import type { Class } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import '@spinajs/log';
import { Migration, Orm, OrmDriver, OrmMigration, OrmMigrator, QueryContext, type IDriverOptions } from '@spinajs/orm';
import type { PgliteOrmDriver } from '@spinajs/orm-pglite';
import { createTestApp } from '@spinajs/testing';

import { TEST_PGLITE_INSTANCE, createTestDatabase } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };

@Migration('default')
export class TestingOrmDatabase_2026_11_03_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('tdb_items', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Name');
    });
  }

  public down(): Promise<void> {
    return Promise.resolve();
  }
}

function appConfiguration(connection: Partial<IDriverOptions>): Class<Configuration> {
  return class DatabaseTestConfiguration extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      this.set('logger', SILENT);
      // Other test files of this package register models; their tables are not this test's concern.
      this.set('db', { DefaultConnection: 'default', StrictTableCheck: false, Connections: [connection] });
    }
  };
}

async function withApp(connection: Partial<IDriverOptions>, fn: (driver: PgliteOrmDriver) => Promise<void>): Promise<void> {
  const app = await createTestApp({ configuration: appConfiguration(connection), resolve: [OrmMigrator] });
  try {
    await fn((await app.resolve(Orm)).Connections.get('default') as PgliteOrmDriver);
  } finally {
    await app.dispose();
  }
}

const optionsOf = (config: Partial<IDriverOptions>) => config.Options as { Shared?: string; Schema?: string; LoadDataDir?: string };
const names = (driver: PgliteOrmDriver) => driver.executeOnDb('SELECT "Name" FROM tdb_items', [], QueryContext.Select);

describe('createTestDatabase', function () {
  it('gives every call its own schema on one shared PGlite instance, migrated on the boot', async () => {
    const a = await createTestDatabase();
    const b = await createTestDatabase();

    expect(optionsOf(a.config).Shared).to.equal(TEST_PGLITE_INSTANCE);
    expect(optionsOf(b.config).Shared).to.equal(TEST_PGLITE_INSTANCE);
    expect(optionsOf(a.config).Schema).to.match(/^tdb_\d+_[0-9a-f]{8}$/);
    expect(optionsOf(a.config).Schema).to.not.equal(optionsOf(b.config).Schema);
    expect(a.config.Migration).to.deep.equal({ OnStartup: true });

    await withApp(a.config, async (driver) => {
      await driver.executeOnDb('INSERT INTO tdb_items ("Name") VALUES (?)', ['in a'], QueryContext.Insert);
    });
    await withApp(b.config, async (driver) => {
      expect(await names(driver)).to.deep.equal([]);
    });

    await a.dispose();
    await b.dispose();
  });

  it('dispose() drops the schema', async () => {
    const db = await createTestDatabase();
    await withApp(db.config, async (driver) => {
      await driver.executeOnDb('INSERT INTO tdb_items ("Name") VALUES (?)', ['gone after dispose'], QueryContext.Insert);
    });

    await db.dispose();

    // The same entry boots again into a recreated, freshly migrated schema.
    await withApp(db.config, async (driver) => {
      expect(await names(driver)).to.deep.equal([]);
    });
    await db.dispose();
  });

  it('migrate: false gives an empty schema', async () => {
    const db = await createTestDatabase({ migrate: false });

    expect(db.config.Migration).to.deep.equal({ OnStartup: false });
    await withApp(db.config, async (driver) => {
      expect(await driver.tableInfo('tdb_items')).to.equal(null);
    });
    await db.dispose();
  });

  it("strategy 'template' migrates once per process and loads a copy per boot", async () => {
    const a = await createTestDatabase({ strategy: 'template' });
    const b = await createTestDatabase({ strategy: 'template' });

    expect(optionsOf(a.config).LoadDataDir).to.be.a('string').and.equal(optionsOf(b.config).LoadDataDir);
    expect(existsSync(optionsOf(a.config).LoadDataDir!)).to.equal(true);

    await withApp(a.config, async (driver) => {
      // The boot did not migrate again: a second CREATE TABLE would have failed it.
      expect(await driver.tableInfo('tdb_items')).to.not.equal(null);
      await driver.executeOnDb('INSERT INTO tdb_items ("Name") VALUES (?)', ['only here'], QueryContext.Insert);
    });
    await withApp(a.config, async (driver) => {
      expect(await names(driver)).to.deep.equal([]);
    });
  });

  it("strategy 'template' builds one template per configuration class", async () => {
    class OtherConfiguration extends FrameworkConfiguration {}

    const plain = await createTestDatabase({ strategy: 'template' });
    const other = await createTestDatabase({ strategy: 'template', configuration: OtherConfiguration });

    expect(optionsOf(other.config).LoadDataDir).to.not.equal(optionsOf(plain.config).LoadDataDir);
  });

  it("refuses strategy 'template' with migrate: false instead of silently taking the schema path", async () => {
    await expect(createTestDatabase({ strategy: 'template', migrate: false })).to.be.rejectedWith(InvalidArgument, /template is a migrated database; use migrate: false with strategy 'schema'/);
  });

  it('sqlite is an in-memory connection the app migrates', async () => {
    const db = await createTestDatabase({ dialect: 'sqlite', connection: 'main' });

    expect(db.config).to.deep.equal({ Driver: 'orm-driver-sqlite', Name: 'main', Filename: ':memory:', Migration: { OnStartup: true } });
  });

  it('works through createTestApp({ config }), which carries the entry as JSON', async () => {
    const db = await createTestDatabase();
    expect(JSON.parse(JSON.stringify(db.config))).to.deep.equal(db.config);

    const app = await createTestApp({ config: { logger: SILENT, db: { DefaultConnection: 'default', StrictTableCheck: false, Connections: [db.config] } }, resolve: [OrmMigrator] });
    try {
      expect(await (await app.resolve(Orm)).Connections.get('default')!.tableInfo('tdb_items')).to.not.equal(null);
    } finally {
      await app.dispose();
    }
    await db.dispose();
  });
});
