import { FrameworkConfiguration } from '@spinajs/configuration';
import chai from 'chai';
import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';
import chaiSubset from 'chai-subset';
import chaiLike from 'chai-like';
import chaiThings from 'chai-things';
import { DateTime } from 'luxon';
import { MigrationTransactionMode } from '@spinajs/orm';

chai.use(chaiHttp);
chai.use(chaiAsPromised);
chai.use(chaiSubset);
chai.use(chaiLike);
chai.use(chaiThings);

export const TestEventChannelName = `/topic/test-${DateTime.now().toMillis()}`;
export const TestJobChannelName = `/queue/test-${DateTime.now().toMillis()}`;
export const QUEUE_WAIT_TIME_MS = 5 * 1000;

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

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

          changePassword: {
            enabled: true,
            template: './user-change-password-template.pug',
            subject: 'Password change request',
          },

          // when user is created & activated should he receive email
          created: {
            enabled: true,
            template: './user-creation-email-template.pug',
            subject: 'Please confirm your email',
          },

          banned: {
            enabled: true,
            template: './user-banned-email-template.pug',
            subject: 'Account banned',
          },

          unbanned: {
            enabled: true,
            template: './user-unbanned-email-template.pug',
            subject: 'Account unbanned',
          },

          deleted: {
            enabled: true,
            template: './user-deleted-email-template.pug',
            subject: 'Account deleted',
          },

          activated: {
            enabled: true,
            template: './user-deactivated-email-template.pug',
            subject: 'Account deactivated',
          },

          deactivated: {
            enabled: true,
            template: './user-deactivated-email-template.pug',
            subject: 'Account deactivated',
          },

          // when user is created, should he confirm email
          // if false, user is acvite at creation,
          // when true, first, user will be sent confirmation email
          confirm: {
            enabled: true,
            template: './user-confirmation-email-template.pug',
            subject: 'Account created',
          },
        },
        // default roles to manage users & guest account
        roles: [
          {
            Name: 'admin',
            Description: 'Administrator',
          },
          {
            Name: 'user',
            Description: 'Simple account without any privlidge',
          },
          {
            Name: 'guest',
            Description: 'Guest account',
          },
        ],
        defaultRole: 'guest',
        session: {
          // 2h session expiration  time
          expiration: 120,
        },
        auth: {
          service: 'SimpleDbAuthProvider',
        },
        password: {
          service: 'BasicPasswordProvider',

          validation: {
            service: 'BasicPasswordValidationProvider',
            rule: {
              // UNCOMMENT ONE OF BELOW OR MODIFY
              // VALIDATION RULE IS JSON SCHEMA

              // Minimum eight characters, at least one letter and one number
              pattern: '^(?=.*[A-Za-z])(?=.*d)[A-Za-zd]{8,}$',

              // Minimum eight characters, at least one letter, one number and one special character:
              // pattern: '^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#?&])[A-Za-z\d@$!%*#?&]{8,}$',

              // Minimum eight characters, at least one uppercase letter, one lowercase letter and one number
              // pattern: '^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d]{8,}$',

              // Minimum eight characters, at least one uppercase letter, one lowercase letter and one number
              // pattern: '^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$',

              type: 'string',
            },
          },

          /**
           * Should password expire after some time ?
           */
          passwordExpirationTime: 0,

          /**
           * How long we should wait to reset password ( after this time reset token is invalid )
           */
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
        routing: {
          NewUser: { connection: 'default-test-queue' },
          UserActivated: { connection: 'default-test-queue' },
          UserBanned: { connection: 'default-test-queue' },
          UserDeactivated: { connection: 'default-test-queue' },
          UserDeleted: { connection: 'default-test-queue' },
          UserLogged: { connection: 'default-test-queue' },
          UserPropertyChanged: { connection: 'default-test-queue' },
          UserUnbanned: { connection: 'default-test-queue' },
          UserPasswordChanged: { connection: 'default-test-queue' },
          UserPasswordChangeRequest: { connection: 'default-test-queue' },
          UserRoleGranted: { connection: 'default-test-queue' },
          UserRoleRevoked: { connection: 'default-test-queue' },
          UserMetadataChange: { connection: 'default-test-queue' },
        },

        connections: [
          {
            service: 'BlackHoleQueueClient',
            name: `default-test-queue`,
          },
        ],
      },

      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          // queue DB
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'queue',
            Migration: {
              OnStartup: true,
              Table: 'orm_migrations',
              Transaction: {
                Mode: MigrationTransactionMode.PerMigration,
              },
            },
          },

          {
            Debug: {
              Queries: true,
            },
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'sqlite',
            Migration: {
              Table: 'orm_migrations',
              OnStartup: true,
            },
          },
        ],
      },
    };
  }
}
