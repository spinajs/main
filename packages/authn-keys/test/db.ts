import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthnKeys_2026_10_02_00_00_00 } from '../src/migrations/index.js';
import { AuthnKey } from '../src/models/index.js';

/** In-memory sqlite with the authn-keys migration; the other packages' shipped config stays as apps get it. */
export class KeysDbConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'sqlite',
            Migration: { Table: 'orm_migrations', OnStartup: true, Transaction: { Mode: MigrationTransactionMode.PerMigration } },
          },
        ],
      },
    };
  }
}

let booted: Promise<Orm> | null = null;

/** Boots once per mocha process; the migration registers itself through its decorator. */
export function bootSqlite(): Promise<Orm> {
  booted ??= (async () => {
    void AuthnKeys_2026_10_02_00_00_00;
    DI.setESMModuleSupport();
    DI.register(KeysDbConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }
    await DI.resolve(Configuration);
    return DI.resolve(Orm);
  })();
  return booted;
}

export async function clearKeys(): Promise<void> {
  await AuthnKey.truncate();
}
