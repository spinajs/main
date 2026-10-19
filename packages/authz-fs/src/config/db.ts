// Package config merges before the app's, so an app's db.Aliases['authz-fs'] wins.
const authzFsConnection = {
  db: {
    Aliases: {
      'authz-fs': 'default',
    },
  },
};

export default authzFsConnection;
