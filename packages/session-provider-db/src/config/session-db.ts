const sessionDb = {
  authn: {
    session: {
      db: {
        cleanupInterval: 10 * 60 * 1000,
        cleanupBatch: 500,
      },
    },
  },
};

export default sessionDb;
