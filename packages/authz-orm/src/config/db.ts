// Package config merges before the app's, so an app's db.Aliases.authz wins.
const authzConnection = {
  db: {
    Aliases: {
      authz: 'default',
    },
  },
};

export default authzConnection;
