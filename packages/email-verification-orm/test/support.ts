import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { EmailVerificationStore } from '@spinajs/email-verification';
import '@spinajs/email-verification/register-schema';
import { OrmEmailVerificationStore } from '../src/index.js';
import { ENTRIES_TABLE, META_TABLE, SOURCES_TABLE, VERDICTS_TABLE } from '../src/tables.js';

const DEFAULT_CONNECTION = 'email-verification-connection';
let connectionName = DEFAULT_CONNECTION;

export class OrmStoreTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      emailVerification: { enabled: true, store: 'OrmEmailVerificationStore', orm: { connection: DEFAULT_CONNECTION } },
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: DEFAULT_CONNECTION, Migration: { OnStartup: true } },
          { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'other-connection', Migration: { OnStartup: true } },
          { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite', Migration: { OnStartup: true } },
        ],
      },
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
    };
  }
}

// Configuration stays cached: InternalLogger flushes its buffer only on the first resolve, so a re-resolved
// Configuration would leave its boot log in the buffer to be dumped on exit.
const OWNED: unknown[] = [Orm, EmailVerificationStore, OrmEmailVerificationStore];
let registered = false;
let current: { orm: Orm; store: OrmEmailVerificationStore } | undefined;

export async function disposeStore(): Promise<void> {
  if (current) {
    await current.store.dispose();
    await current.orm.dispose();
    current = undefined;
  }
  for (const t of OWNED) DI.uncache(t as never);
}

/** A fresh in-memory database with the migration applied on `connection`, and the store over it. */
export async function bootStore(connection = DEFAULT_CONNECTION): Promise<OrmEmailVerificationStore> {
  await disposeStore();
  if (!registered) {
    DI.setESMModuleSupport();
    DI.register(OrmStoreTestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
    registered = true;
  }
  (await DI.resolve(Configuration)).set('emailVerification.orm.connection', connection);
  connectionName = connection;
  const orm = await DI.resolve(Orm);
  const store = await DI.resolve(OrmEmailVerificationStore);
  current = { orm, store };
  return store;
}

export async function driver(): Promise<OrmDriver> {
  return (await DI.resolve(Orm)).Connections.get(connectionName)!;
}

export async function truncate(): Promise<void> {
  const d = await driver();
  // Every key is non-empty; the WHERE keeps the delete builder from refusing an unconditioned DELETE.
  for (const table of [VERDICTS_TABLE, SOURCES_TABLE, ENTRIES_TABLE, META_TABLE]) await d.del().from(table).where('key', '!=', '');
}
