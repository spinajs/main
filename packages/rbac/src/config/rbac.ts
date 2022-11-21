import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

module.exports = {
  system: {
    dirs: {
      cli: [dir('./../cli')],
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
        transport: 'BlackHoleQueueClient',
        defaultQueueChannel: 'rbac-jobs',
        defaultTopicChannel: 'rbac-events',
      },
    ],
  },
  rbac: {
    timeline: {
      schedule: '1 0 */1 * *', // delete old entries once a day
      ttl: 24 * 60,
    },
    users: {
      // when user is created, should he confirm email
      // if false, user is acvite at creation,
      // when true, first, user will be sent confirmation email
      emailConfimationOnCreation: false,

      minPasswordLength: 6,

      maxPasswordLength: 16,

      /**
       * Should password expire after some time ?
       */
      passwordExpirationTime: 0,
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
          'read:own': ['Email', 'Login', 'NiceName'],
          'update:own': ['Email', 'Login', 'Password', 'NiceName'],
        },
      },
      admin: {
        $extend: ['admin.users'],
      },
    },
    defaultRole: 'guest',
    auth: {
      provider: 'SimpleDbAuthProvider',
    },
    password: {
      provider: 'BasicPasswordProvider',
      minPasswordLength: 6,
    },
    session: {
      provider: 'MemorySessionStore',

      // 2h session expiration  time
      // time in minutes
      expiration: 120,
    },
  },
};
