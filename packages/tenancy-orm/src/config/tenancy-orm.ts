// Package config merges before the app's, so an app's db.Aliases.tenancy wins.
const tenancyOrm = {
  db: {
    Aliases: {
      tenancy: 'default',
    },
  },
};

export default tenancyOrm;
