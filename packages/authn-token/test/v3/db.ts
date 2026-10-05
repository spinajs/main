import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode, Orm, OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

import { dir, dropOwnCompiledDirs, registerAuthnSchema } from '../db-common.js';

const CONNECTION = 'sqlite';

/**
 * In-memory sqlite with this package's migrations, for the 3.0 suites. Never
 * imports `@spinajs/users`: its migrations only run when a legacy suite in
 * the same mocha process has imported it.
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

/**
 * Boots a fresh database; anything a previous suite left cached under these
 * types is dropped first.
 */
export async function bootV3Db(): Promise<OrmDriver> {
  DI.setESMModuleSupport();
  uncacheOwn();

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
 * with the columns of `@spinajs/users`' `RBACInitial_2022_06_28_01_13_00`,
 * because that migration only runs when some suite imported the package.
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
      table.string('Role', 256).notNull();
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
    .values({ Uuid: uuid, Email: `${uuid}@spinajs.test`, Password: 'not-a-hash', Login: uuid, Role: 'user', IsActive: 1 });

  return result.LastInsertId;
}
