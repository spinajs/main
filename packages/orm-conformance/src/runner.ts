import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import type { Class } from '@spinajs/di';
import '@spinajs/log';
import { Orm, type OrmDriver } from '@spinajs/orm';
// Each import registers its driver token.
import '@spinajs/orm-mssql';
import '@spinajs/orm-mysql';
import '@spinajs/orm-pglite';
import '@spinajs/orm-postgres';
import '@spinajs/orm-sqlite';
import { createTestApp } from '@spinajs/testing';

import type { ConformanceCase, ConformanceDb } from './case.js';
import type { TargetResults } from './compare.js';
import { resetFixture, seedFixture } from './fixture.js';
import { CONFORMANCE_CONNECTION } from './models.js';
import { normalizeResult } from './normalize.js';
import type { ConformanceTarget } from './targets.js';

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };

function conformanceConfiguration(target: ConformanceTarget): Class<Configuration> {
  return class ConformanceConfiguration extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      this.set('logger', SILENT);
      // The fixture tables are created after the boot, case by case.
      this.set('db', {
        DefaultConnection: CONFORMANCE_CONNECTION,
        StrictTableCheck: false,
        Connections: [{ ...target.connection, Name: CONFORMANCE_CONNECTION, Migration: { OnStartup: false } }],
      });
    }
  };
}

async function outcome(c: ConformanceCase, db: ConformanceDb): Promise<unknown> {
  try {
    return await c.run(db);
  } catch (err) {
    return { $error: err instanceof Error ? err.constructor.name : typeof err };
  }
}

async function runCase(c: ConformanceCase, db: ConformanceDb, driver: OrmDriver, reloadDescriptors: boolean): Promise<unknown> {
  try {
    await resetFixture(driver);
    if (reloadDescriptors) {
      // Model descriptors take their columns from the live tables, which did not exist at the boot.
      await db.orm.reloadTableInfo();
    }
    await seedFixture(driver, c.seed);
  } catch (err) {
    return { $fixtureError: err instanceof Error ? err.message : String(err) };
  }

  return outcome(c, db);
}

/** Boots `target`, runs every case on a freshly created fixture, and returns the normalized results by case name. */
export async function runTarget(target: ConformanceTarget, cases: readonly ConformanceCase[]): Promise<TargetResults> {
  const app = await createTestApp({ name: `orm-conformance ${target.name}`, configuration: conformanceConfiguration(target) });
  const results = new Map<string, unknown>();

  try {
    const orm = await app.resolve(Orm);
    const driver = orm.Connections.get(CONFORMANCE_CONNECTION)!;
    const db: ConformanceDb = { target: target.name, orm, driver };

    let first = true;
    for (const c of cases) {
      results.set(c.name, normalizeResult(await runCase(c, db, driver, first), { order: c.order, booleans: c.booleans }));
      first = false;
    }
  } finally {
    await app.dispose();
  }

  return results;
}
