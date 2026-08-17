import { FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode } from '@spinajs/orm';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiSubset from 'chai-subset';
import { join, normalize, resolve } from 'path';

chai.use(chaiAsPromised);
chai.use(chaiSubset);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * Configuration for the admin controller suites.
 *
 * NOTE: `rbac.actions` is deliberately absent. Applications usually do not
 * declare it, and user creation must work without it — see the
 * `beforeCreate` regression test in `users-controller.test.ts`.
 */
export class TestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
          },
        ],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      rbac: {
        email: {
          connection: 'rbac-email-connection',
          created: {
            enabled: false,
            template: './user-creation-email-template.pug',
            subject: 'Please confirm your email',
          },
          changePassword: {
            enabled: false,
            template: './user-change-password-template.pug',
            subject: 'Password change request',
          },
          activated: {
            enabled: false,
            template: './user-activated-email-template.pug',
            subject: 'Account activated',
          },
          deactivated: {
            enabled: false,
            template: './user-deactivated-email-template.pug',
            subject: 'Account deactivated',
          },
          deleted: {
            enabled: false,
            template: './user-deleted-email-template.pug',
            subject: 'Account deleted',
          },
          banned: {
            enabled: false,
            template: './user-banned-email-template.pug',
            subject: 'Account banned',
          },
          unbanned: {
            enabled: false,
            template: './user-unbanned-email-template.pug',
            subject: 'Account unbanned',
          },
        },
        roles: [
          { Name: 'admin', Description: 'Administrator' },
          { Name: 'superadmin', Description: 'Administrator that can also read secrets' },
          { Name: 'user', Description: 'Simple account' },
          { Name: 'guest', Description: 'Guest account' },
          { Name: 'scoped-admin', Description: 'Admin restricted to their own visible scope (test fixture)' },
        ],
        grants: {
          system: {
            $extend: ['admin'],
          },
          superadmin: {
            $extend: ['admin'],
            secrets: { 'read:any': ['*'] },
          },
          admin: {
            users: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
          },
          user: {
            users: { 'read:own': ['*'], 'update:own': ['*'] },
          },
          // Fixture role for the own-permission route-gate tests: read:own/update:own
          // only, so it can prove the Own twin opens the route without also holding
          // the Any grant that would make the assertion trivially true.
          'scoped-admin': {
            users: { 'read:own': ['*'], 'update:own': ['*'] },
          },
        },
        defaultRole: 'guest',
        systemRole: 'system',

        // Guard defaults are normally supplied by this package's own config file,
        // which the test configuration does not load — declared here so the
        // suites exercise the shipped values rather than an empty object.
        admin: {
          roleGuard: {
            service: 'DefaultRoleGuard',
            requireKnownRole: true,
            protectSystemRole: true,
            preventEscalation: true,
            preventSelfLockout: true,
            preventLastPrivilegedRemoval: true,
            privilegedResource: 'users',
            privilegedAction: 'update:any',
          },
        },
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
        // mirrors what the rbac package ships as its default
        user: {
          profile: 'BasicProfileProvider',
        },
        twoFactorAuth: {
          enabled: true,
          forceUser: false,
          service: 'Default2FaToken',
        },
        otpauth: {
          issuer: 'spinajs-test',
          algorithm: 'SHA1',
          digits: 6,
          period: 30,
          window: 1,
          secretSize: 20,
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
        connections: [
          {
            name: 'rbac-email-connection',
            service: 'BlackHoleEmailSender',
          },
        ],
      },

      queue: {
        default: 'default-test-queue',
        connections: [
          {
            service: 'BlackHoleQueueClient',
            name: 'default-test-queue',
          },
        ],
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
              Transaction: {
                Mode: MigrationTransactionMode.PerMigration,
              },
            },
          },
        ],
      },
    };
  }
}
