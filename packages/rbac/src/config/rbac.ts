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
      NewUser: { connection: 'rbac-user-queue' },
      UserActivated: { connection: 'rbac-user-queue' },
      UserBanned: { connection: 'rbac-user-queue' },
      UserDeactivated: { connection: 'rbac-user-queue' },
      UserDeleted: { connection: 'rbac-user-queue' },
      UserLoginFailed: { connection: 'rbac-user-queue' },
      UserMetadataAdded: { connection: 'rbac-user-queue' },
      UserMetadataChanged: { connection: 'rbac-user-queue' },
      UserMetadataDeleted: { connection: 'rbac-user-queue' },
      UserPropertyChanged: { connection: 'rbac-user-queue' },
      UserUnbanned: { connection: 'rbac-user-queue' },
    },

    // by default all events from rbac module are routed to rbac-user-queue
    // and is using empty sink ( no events are sent )
    connections: [
      {
        name: 'rbac-user-queue',
        transport: 'BlackHoleQueueClient',
        defaultQueueChannel: 'rbac-jobs',
        defaultTopicChannel: 'rbac-events',
      },
    ],
  },
  rbac: {
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
