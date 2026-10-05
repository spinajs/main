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
 * The role world of the admin suites: the 2.x fixture as authz-rbac roles. `admin` may manage
 * assignments and holds every `users:*` permission, so it may grant any role but `superadmin` (escalation)
 * and `system` (not assignable).
 */
export const TEST_ROLES = {
  guest: {},
  user: {},
  'scoped-admin': {},
  // users:update on one's own record only: a conditional grant.
  'self-editor': { grants: [{ permission: 'users:update', relation: 'self' }] },
  admin: { grants: ['users:read', 'users:create', 'users:update', 'users:delete', 'authz:assignments.manage'] },
  superadmin: { extends: ['admin'], grants: ['secrets:read'] },
  system: { assignable: false, extends: ['admin'] },
};

/**
 * Configuration for the admin controller suites.
 *
 * NOTE: `users.actions` is deliberately absent. Applications usually do not
 * declare it, and user creation must work without it — see the
 * `beforeCreate` regression test in `users-controller.test.ts`.
 */
export class TestConfiguration extends FrameworkConfiguration {
  public async load() {
    await super.load();

    // In ESM mode every built @spinajs package config fragment merges in, and their `authz.rbac` roles
    // (users' `admin` with glob grants, configuration-http's `admin.configuration`, ...) would merge
    // into this fixture's. The suites test this package against a world they define.
    this.set(['authz', 'rbac'], { roles: TEST_ROLES });
  }

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
      users: {
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
          passwordExpired: {
            enabled: false,
            template: './user-password-expired-template.pug',
            subject: 'Password expired',
          },
          passwordWillExpire: {
            enabled: false,
            template: './user-password-will-expire-soon.pug',
            subject: 'Your password will expire soon',
          },
        },
        // mirrors what the users package ships as its default
        user: {
          profile: 'BasicProfileProvider',
        },
      },
      rbac: {
        auth: {
          service: 'SimpleDbAuthProvider',
        },
        twoFactorAuth: {
          enabled: true,
          forceUser: false,
          service: 'Default2FaToken',
        },
        password: {
          passwordExpirationTime: 0,
        },
      },

      // A real root authz host (test/support/authz-host.ts): roles are GLOBAL assignments written through
      // AuthzAdmin (DbAuthzAdminBackend) into the test database.
      authz: {
        permissions: {
          'users:read': { fields: true },
          'users:create': {},
          'users:update': { fields: true },
          'users:delete': {},
          'authz:assignments.manage': {},
          'secrets:read': {},
        },
        admin: {
          backend: 'DbAuthzAdminBackend',
          guard: {
            service: 'DefaultAdminGuard',
            privilegedPermission: 'users:update',
            protectSystemRole: true,
            preventEscalation: true,
            preventSelfLockout: true,
            preventLastPrivilegedRemoval: true,
          },
        },
      },

      authn: {
        session: {
          service: 'MemorySessionStore',
          expiration: {
            service: 'SlidingCappedExpiration',
            ttl: 120,
            maxLifetime: 1440,
          },
          cookie: {},
        },
        local: {
          hasher: { service: 'BasicPasswordProvider' },
          policy: {
            service: 'BasicPasswordValidationProvider',
            rule: {
              pattern: '^(?=.*\\d).{8,}$',
              type: 'string',
            },
          },
          reset: { ttlSeconds: 60 * 60 },
        },
        mfa: {
          totp: {
            issuer: 'spinajs-test',
            algorithm: 'SHA1',
            digits: 6,
            period: 30,
            window: 1,
            secretSize: 20,
          },
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
