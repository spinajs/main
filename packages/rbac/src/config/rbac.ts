import { join, normalize, resolve } from 'path';
 
function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.cwd(), 'node_modules', '@spinajs', 'rbac', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.cwd(),'../','node_modules', '@spinajs', 'rbac', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

 

const rbac = {
  system: {
    dirs: {
      cli: [...dir('cli')],
    },
  },
  queue: {
    routing: {
      NewUser: { connection: 'rbac-user-empty-queue' },
      UserActivated: { connection: 'rbac-user-empty-queue' },
      UserBanned: { connection: 'rbac-user-empty-queue' },
      UserDeactivated: { connection: 'rbac-user-empty-queue' },
      UserDeleted: { connection: 'rbac-user-empty-queue' },
      UserLogged: { connection: 'rbac-user-empty-queue' },
      UserPropertyChanged: { connection: 'rbac-user-empty-queue' },
      UserUnbanned: { connection: 'rbac-user-empty-queue' },
      UserPasswordChanged: { connection: 'rbac-user-empty-queue' },
      UserPasswordChangeRequest: { connection: 'rbac-user-empty-queue' },
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

      deactivated: {
        enabled: true,
        template: './user-deactivated-email-template.pug',
        subject: 'Account deactivated',
      },

      passwordExpired: {
        enabled: true,
        template: './user-password-expired-template.pug',
        subject: 'Password expired',
      },

      passwordWillExpire: {
        enabled: true,
        template: './user-password-will-expire-soon.pug',
        subject: 'Your password will expire soon',
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

      expiration: {
        enabled: true,

        // in seconds
        passwordExpirationTime: 31 * 24 * 60 * 60,
      },

      /**
       * How long we should wait to reset password ( after this time reset token is invalid )
       */
      passwordResetWaitTime: 60 * 60,
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
