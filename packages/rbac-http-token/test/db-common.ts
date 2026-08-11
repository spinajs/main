import { FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * Boots in-memory sqlite with rbac + this package's migrations and models.
 * No http server.
 */
export class DbTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      system: {
        dirs: {
          // A configured value REPLACES the orm defaults, so this list is the whole
          // filesystem scan set: this package's migrations, run from source. `@spinajs/rbac`'s
          // own migrations still arrive through the DI registry ( its index exports them and
          // the tests import it ), so the users table is created regardless.
          migrations: [dir('./../src/migrations')],
          // Not read by the orm ( models are registered by the `@Model` decorator when the
          // file is imported ) - kept for symmetry with how apps declare their dirs.
          models: [dir('./../src/models')],
        },
      },
      rbac: {
        defaultRole: 'guest',
        roles: [
          { Name: 'admin', Description: 'Administrator' },
          { Name: 'user', Description: 'Simple account' },
          { Name: 'guest', Description: 'Guest account' },
        ],
        grants: {
          admin: {
            users: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
            'user.tokens': { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
          },
          user: {
            user: { 'read:own': ['*'], 'update:own': ['*'] },
            'user.tokens': { 'create:own': ['*'], 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
          },
        },
        session: {
          service: 'MemorySessionStore',
          expiration: { service: 'SlidingCappedExpiration', ttl: 120, maxLifetime: 1440 },
          cookie: {},
        },
        auth: { service: 'SimpleDbAuthProvider' },
        password: {
          service: 'BasicPasswordProvider',
          validation: {
            service: 'BasicPasswordValidationProvider',
            rule: { pattern: '^(?=.*\\d).{8,}$', type: 'string' },
          },
          passwordExpirationTime: 0,
          passwordResetWaitTime: 60 * 60,
        },
        token: {
          generation: { service: 'SecureRandomTokenProvider' },
          prefix: 'spt_',
          length: 32,
          headerName: 'x-api-key',
          lastUsedUpdateInterval: 60,
        },
      },
      queue: {
        default: 'default-test-queue',
        connections: [{ service: 'BlackHoleQueueClient', name: 'default-test-queue' }],
      },
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'sqlite',
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
