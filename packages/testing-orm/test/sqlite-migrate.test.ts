import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Migration, Orm, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import { createTestApp } from '@spinajs/testing';

import { createTestDatabase } from '../src/index.js';

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };
const CONNECTION = 'tdb-sqlite';
const SEEDED: string[] = [];

@Migration(CONNECTION)
export class TestingOrmSqlite_2026_11_19_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('tdb_sqlite_items', (t) => {
      t.int('Id').primaryKey().autoIncrement();
    });
  }

  public down(): Promise<void> {
    return Promise.resolve();
  }

  public data(): Promise<void> {
    SEEDED.push('seeded');
    return Promise.resolve();
  }
}

async function bootSqlite(seed?: boolean): Promise<{ orm: Orm; dispose: () => Promise<void> }> {
  const db = await createTestDatabase({ dialect: 'sqlite', connection: CONNECTION });
  const app = await createTestApp({ config: { logger: SILENT, db: { DefaultConnection: CONNECTION, StrictTableCheck: false, Connections: [db.config] } } });
  try {
    const orm = await db.migrate(app.container, seed === undefined ? undefined : { seed });
    return { orm, dispose: () => app.dispose() };
  } catch (err) {
    await app.dispose();
    throw err;
  }
}

describe('TestDatabase.migrate() on sqlite', function () {
  this.timeout(60000);

  beforeEach(() => {
    SEEDED.length = 0;
  });

  after(() => {
    DI.unregister(TestingOrmSqlite_2026_11_19_00_00_00);
  });

  it('migrates the in-memory database the app then uses, and runs the seeds', async () => {
    const { orm, dispose } = await bootSqlite();
    try {
      // :memory: lives in one connection: the app's Orm has to be the one the tool migrated
      expect(await DI.resolve(Orm)).to.equal(orm);
      expect(await orm.Connections.get(CONNECTION)!.tableInfo('tdb_sqlite_items')).to.not.equal(null);
      expect(SEEDED).to.deep.equal(['seeded']);
    } finally {
      await dispose();
    }
  });

  it('with { seed: false } applies the migrations without their seeds', async () => {
    const { orm, dispose } = await bootSqlite(false);
    try {
      expect(await orm.Connections.get(CONNECTION)!.tableInfo('tdb_sqlite_items')).to.not.equal(null);
      expect(SEEDED).to.deep.equal([]);
    } finally {
      await dispose();
    }
  });
});
