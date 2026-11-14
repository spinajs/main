// Package config merges before the app's, so an app's db.Aliases.idempotency wins.
const idempotency = {
  db: {
    Aliases: {
      idempotency: 'default',
    },
  },
};

export default idempotency;
