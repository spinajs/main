import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode, Orm, OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { IdentityStore, RoleSource } from '@spinajs/authn/contracts';

import { dir, dropOwnCompiledDirs, registerAuthnSchema } from '../db-common.js';

const CONNECTION = 'sqlite';

/**
 * In-memory sqlite with this package's migrations, for the 3.0 suites. No
 * `users` table exists until {@link insertUserRow} creates it.
 */
export class V3DbConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    dropOwnCompiledDirs(this);
  }

  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      system: {
        dirs: {
          migrations: [dir('./../src/migrations')],
        },
      },
      db: {
        DefaultConnection: CONNECTION,
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: CONNECTION,
            Migration: {
              Table: 'orm_migrations',
              OnStartup: true,
              Transaction: { Mode: MigrationTransactionMode.PerMigration },
            },
          },
        ],
      },
    };
  }
}

function uncacheOwn(): void {
  DI.uncache(Orm);
  DI.uncache(Configuration);
  DI.uncache(V3DbConfiguration);
  DI.uncache('orm-driver-sqlite');
  DI.uncache(SqliteOrmDriver);
}

// An earlier suite may leave a RoleSource or IdentityStore registered; the 3.0
// suites register their own or assert there is none. Unregistering alone leaves an empty entry, which DI resolves
// differently from an unregistered port, so the port is registered as itself: what DI records when it resolves one.
const FOREIGN_PORTS = [RoleSource, IdentityStore] as Class<unknown>[];
let restoreForeign: (() => void) | undefined;

function hideForeignRegistrations(): void {
  if (restoreForeign) {
    return;
  }
  const hidden = FOREIGN_PORTS.map((port) => ({ port, types: (DI.getRegisteredTypes(port) ?? []).filter((type) => type !== port) })).filter((h) => h.types.length > 0);
  for (const { port, types } of hidden) {
    types.forEach((type) => DI.unregister(type));
    DI.register(port).as(port);
    DI.uncache(port);
  }
  restoreForeign = () => {
    for (const { port, types } of hidden) {
      DI.unregister(port);
      types.forEach((type) => DI.register(type).as(port));
      DI.uncache(port);
    }
    restoreForeign = undefined;
  };
}

/**
 * Boots a fresh database; anything a previous suite left cached under these
 * types is dropped first.
 */
export async function bootV3Db(): Promise<OrmDriver> {
  DI.setESMModuleSupport();
  uncacheOwn();
  hideForeignRegistrations();

  DI.register(V3DbConfiguration).as(Configuration);
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  registerAuthnSchema();

  await DI.resolve(Configuration);
  await DI.resolve(Orm);

  return v3Connection();
}

export async function shutdownV3Db(): Promise<void> {
  await DI.get(Orm)?.dispose();
  uncacheOwn();
  DI.unregister(V3DbConfiguration);
  restoreForeign?.();
}

export function v3Connection(): OrmDriver {
  const connection = DI.get(Orm)?.Connections.get(CONNECTION);
  if (!connection) {
    throw new Error('bootV3Db() has not run');
  }

  return connection;
}

/**
 * Inserts a `users` row and returns its `Id`. Creates the table when missing,
 * with the columns `@spinajs/users` leaves after its migrations and authz-rbac's
 * `AuthzRbacDropUserRole` (no `Role`); this package does not depend on users.
 */
export async function insertUserRow(uuid: string): Promise<number> {
  const connection = v3Connection();

  if (!(await connection.schema().tableExists('users'))) {
    await connection.schema().createTable('users', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Uuid', 36).notNull();
      table.string('Email', 64).unique().notNull();
      table.string('Password', 128).notNull();
      table.string('Login', 64).notNull();
      table.boolean('IsActive').notNull().default().value(0);
      table.dateTime('CreatedAt').notNull().default().dateTime();
      table.dateTime('DeletedAt');
      table.dateTime('LastLoginAt');
    });
    await connection.index().unique().table('users').name('user_uuid_idx').columns(['Uuid']);
    await connection.index().unique().table('users').name('user_login_idx').columns(['Login']);
  }

  const result = await connection
    .insert()
    .into('users')
    .values({ Uuid: uuid, Email: `${uuid}@spinajs.test`, Password: 'not-a-hash', Login: uuid, IsActive: 1 });

  return result.LastInsertId;
}
