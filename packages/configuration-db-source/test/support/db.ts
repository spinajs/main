import { DI } from '@spinajs/di';
import '@spinajs/log';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { Configuration } from '@spinajs/configuration';

import { DbConfig, DbConfigSourceBotstrapper } from '../../src/index.js';
import { asSystem } from '../../src/system.js';

type SetConfig = (path: readonly string[], value: unknown) => void;

export interface DbHandle {
  /** Inserts watched rows. */
  seed(rows: readonly { readonly path: string; readonly value: unknown }[]): Promise<void>;
  poll(): Promise<void>;
  value(path: string): unknown;
  dispose(): Promise<void>;
}

/** An in-memory sqlite `configuration` table behind `DbConfig`, over the already installed test Configuration. */
export async function bootDb(setConfig: SetConfig, domain = 'root'): Promise<DbHandle> {
  setConfig(['logger'], { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] });
  setConfig(['db'], { DefaultConnection: 'sqlite', Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite', Migration: { OnStartup: true } }] });

  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  const orm = await DI.resolve(Orm);
  const config = (await DI.resolve(Configuration)) as Configuration;

  const bootstrapper = new DbConfigSourceBotstrapper();
  bootstrapper.authzDomain = domain;
  const watched = (bootstrapper as unknown as { watchedSlugs: Set<string> }).watchedSlugs;

  return {
    async seed(rows) {
      for (const r of rows) {
        await asSystem(() => DbConfig.insert({ Slug: r.path, Value: r.value, Group: 'test', Type: 'string', Watch: true, Exposed: true }), domain);
        watched.add(r.path);
      }
    },
    poll: () => bootstrapper.refreshWatched(),
    value: (path) => config.get(path),
    async dispose() {
      orm.dispose();
      DI.uncache(Orm);
      DI.uncache('orm-driver-sqlite');
      DI.unregister(SqliteOrmDriver);
    },
  };
}
