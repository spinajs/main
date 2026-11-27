import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

import { FakeConfiguration } from '../helpers.js';
import { installQuietLog } from './log.js';

export const sqlite = (name: string): Record<string, unknown> => ({ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: name, Migration: { Table: 'orm_migrations' } });

export interface AclOrm {
  readonly orm: Orm;
  readonly config: Configuration;
  close(): Promise<void>;
}

function unregister(undoLog: () => void): void {
  DI.uncache(Orm);
  DI.uncache(Configuration);
  // The instance is cached under its own class too; the next boot would get it back with this suite's settings.
  DI.uncache(FakeConfiguration);
  DI.unregister(FakeConfiguration);
  DI.unregister(SqliteOrmDriver);
  undoLog();
}

/** An Orm over in-memory SQLite with `db` as its `db` section. Both boot checks are off: the suites create fs_acl by hand, after the boot. */
export async function bootAclOrm(db: Record<string, unknown>): Promise<AclOrm> {
  const undoLog = installQuietLog();
  DI.register(FakeConfiguration).as(Configuration);
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  try {
    const config = await DI.resolve(Configuration);
    config.set(['db'], { MigrationCheck: 'off', StrictTableCheck: false, ...db });
    const orm = await DI.resolve(Orm);
    return {
      orm,
      config,
      async close() {
        for (const c of new Set(orm.Connections.values())) await c.disconnect().catch(() => undefined);
        unregister(undoLog);
      },
    };
  } catch (err) {
    unregister(undoLog);
    throw err;
  }
}
