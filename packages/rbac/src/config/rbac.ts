import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

module.exports = {
  system: {
    dirs: {
      migrations: [dir('./../migrations')],
      models: [dir('./../models')],
    },
  },
  rbac: {
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
    defaultRole: 'guest',
    session: {
      // 2h session expiration  time
      expiration: 120,
    },
  },
};
