import { FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode } from '@spinajs/orm';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

chai.use(chaiAsPromised);

/**
 * Configuration for the database backed user-controller suites.
 *
 * Kept separate from `common.ts` (which drives the http-server based suites) so
 * neither can break the other: this one boots an in-memory sqlite database and
 * never starts a server.
 */
export class DbTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },

      http: {
        cookie: {
          secret: 'rbac-http-user-db-test-secret',
        },
      },

      rbac: {
        email: {
          connection: 'rbac-email-connection',
          created: { enabled: false, template: './created.pug', subject: 'Created' },
          changePassword: { enabled: false, template: './change-password.pug', subject: 'Password change' },
          activated: { enabled: false, template: './activated.pug', subject: 'Activated' },
          deactivated: { enabled: false, template: './deactivated.pug', subject: 'Deactivated' },
          deleted: { enabled: false, template: './deleted.pug', subject: 'Deleted' },
          banned: { enabled: false, template: './banned.pug', subject: 'Banned' },
          unbanned: { enabled: false, template: './unbanned.pug', subject: 'Unbanned' },
        },
        roles: [
          { Name: 'admin', Description: 'Administrator' },
          { Name: 'user', Description: 'Simple account' },
          { Name: 'guest', Description: 'Guest account' },
        ],
        grants: {
          admin: {
            users: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
            'user.metadata': { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
          },
          user: {
            user: { 'read:own': ['*'], 'update:own': ['*'] },
            'user.metadata': { 'create:own': ['*'], 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
          },
        },
        defaultRole: 'guest',
        session: {
          service: 'MemorySessionStore',
          expiration: {
            service: 'SlidingCappedExpiration',
            ttl: 120,
            maxLifetime: 1440,
          },
          cookie: {},
        },
        auth: {
          service: 'SimpleDbAuthProvider',
        },
        // mirrors the values the package ships
        otpauth: {
          issuer: 'Spinajs',
          algorithm: 'SHA1',
          digits: 6,
          period: 30,
          window: 1,
          secretSize: 20,
        },
        twoFactorAuth: {
          enabled: true,
          forceUser: false,
          service: 'Default2FaToken',
        },
        password: {
          service: 'BasicPasswordProvider',
          validation: {
            service: 'BasicPasswordValidationProvider',
            rule: {
              pattern: '^(?=.*\\d).{8,}$',
              type: 'string',
            },
          },
          passwordExpirationTime: 0,
          passwordResetWaitTime: 60 * 60,
        },
      },

      email: {
        connections: [{ name: 'rbac-email-connection', service: 'BlackHoleEmailSender' }],
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
