import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'users', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'users', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

/**
 * Identity keys only (`users.*`) and the roles over users' own resource types. Authentication keys (`authn.*`) come with
 * the authn packages; users ships none, and no 2.x `rbac.*` key.
 */
const usersConfig = {
  system: {
    dirs: {
      cli: [...dir('cli')],
    },
  },
  queue: {
    routing: {
      UserActivated: { connection: 'rbac-user-empty-queue' },
      UserBanned: { connection: 'rbac-user-empty-queue' },
      UserDeactivated: { connection: 'rbac-user-empty-queue' },
      UserDeleted: { connection: 'rbac-user-empty-queue' },
      UserLogged: { connection: 'rbac-user-empty-queue' },
      UserUnbanned: { connection: 'rbac-user-empty-queue' },
      UserPasswordChanged: { connection: 'rbac-user-empty-queue' },
      UserPasswordChangeRequest: { connection: 'rbac-user-empty-queue' },
      UserImpersonationStarted: { connection: 'rbac-user-empty-queue' },
      UserImpersonationEnded: { connection: 'rbac-user-empty-queue' },
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
  users: {
    email: {
      connection: 'rbac-email-connection',

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

      activated: {
        enabled: true,
        template: './user-activated-email-template.pug',
        subject: 'Account activated',
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

    user: {
      profile: 'BasicProfileProvider',
    },

    /**
     * Middleware functions for user actions.
     * Each action can have before and after middleware arrays.
     * Middleware functions receive the User and should return the User.
     * eg. beforeCreate: [(u: User) => { u.Metadata['custom:key'] = 'value'; return u; }]
     */
    actions: {
      create: {
        beforeCreate: [] as Array<Function>,
        afterCreate: [] as Array<Function>,
      },
    },
  },
  authz: {
    rbac: {
      // No defaultRoles or anonymousRoles here: an application's list would be concatenated with ours on merge.
      // create() gives new users authz.rbac.defaultRoles, none unless the application sets it.
      //
      // The grants lists are concatenated with the application's too: it can add grants to these roles, not remove them.
      roles: {
        guest: {
          // user's fields, not §8.2's ['Login']: conditional grants intersect their fields on a check, so a narrower guest
          // would take Email from every account holding both; with none, a summary would list every field.
          grants: [{ permission: 'user:read', relation: 'self', fields: { read: ['Email', 'Login'] } }],
        },
        user: {
          grants: [
            { permission: 'user:read', relation: 'self', fields: { read: ['Email', 'Login'] } },
            { permission: 'user:update', relation: 'self', fields: { write: ['Email', 'Login', 'Password'] } },
            { permission: 'user.metadata:*', relation: 'owner' },
          ],
        },
        'admin.users': {
          assignable: false,
          grants: ['users:*', 'user.metadata:*'],
        },
        admin: {
          extends: ['admin.users'],
          grants: ['user:impersonate'],
        },
      },
    },
  },
};

export default usersConfig;
