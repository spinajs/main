import { join, normalize, resolve } from 'path';
import { DI } from '@spinajs/di';

const isESMMode = DI.get<boolean>('__esmMode__');

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), path)));
}

const rbac = {
  system: {
    dirs: {
      cli: [dir(`node_modules/@spinajs/cli/${isESMMode ? 'mjs/cli' : 'cjs/cli'}`)],
    },
  },
  queue: {
    routing: {
      NewUser: { connection: 'rbac-user-empty-queue' },
      UserActivated: { connection: 'rbac-user-empty-queue' },
      UserBanned: { connection: 'rbac-user-empty-queue' },
      UserDeactivated: { connection: 'rbac-user-empty-queue' },
      UserDeleted: { connection: 'rbac-user-empty-queue' },
      UserLoginFailed: { connection: 'rbac-user-empty-queue' },
      UserMetadataAdded: { connection: 'rbac-user-empty-queue' },
      UserMetadataChanged: { connection: 'rbac-user-empty-queue' },
      UserMetadataDeleted: { connection: 'rbac-user-empty-queue' },
      UserPropertyChanged: { connection: 'rbac-user-empty-queue' },
      UserUnbanned: { connection: 'rbac-user-empty-queue' },
      UserPasswordChanged: { connection: 'rbac-user-empty-queue' },
      UserRoleGranted: { connection: 'rbac-user-empty-queue' },
      UserRoleRevoked: { connection: 'rbac-user-empty-queue' },
    },

    // by default all events from rbac module are routed to rbac-user-empty-queue
    // and is using empty sink ( no events are sent )
    connections: [
      {
        name: 'rbac-user-empty-queue',
        service: 'BlackHoleQueueClient',
        defaultQueueChannel: 'rbac-jobs',
        defaultTopicChannel: 'rbac-events',
      },
    ],
  },
  rbac: {
    enableGuestAccount: false,
    timeline: {
      schedule: '1 0 */1 * *', // delete old entries once a day
      ttl: 24 * 60,
    },
    users: {
      // when user is created, should he confirm email
      // if false, user is acvite at creation,
      // when true, first, user will be sent confirmation email
      emailConfimationOnCreation: false,
    },
    // default roles to manage users & guest account
    roles: [
      {
        Name: 'Admin',
        Description: 'Administrator',
      },
      {
        Name: 'User',
        Description: 'Simple account without any privlidge',
      },
    ],
    grants: {
      'admin.users': {
        users: {
          'create:any': ['*'],
          'read:any': ['*'],
          'update:any': ['*'],
          'delete:any': ['*'],
        },
      },
      user: {
        users: {
          'read:own': ['Email', 'Login'],
          'update:own': ['Email', 'Login', 'Password'],
        },
      },
      admin: {
        $extend: ['admin.users'],
      },
    },
    defaultRole: 'guest',
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
    },
    session: {
      service: 'MemorySessionStore',

      // 2h session expiration  time
      // time in minutes
      expiration: 120,
    },
  },
};

export default rbac;
