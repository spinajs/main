const sessionConfig = {
  authn: {
    session: {
      service: 'MemorySessionStore',

      /** Strategy by service name: AbsoluteExpiration | SlidingExpiration | SlidingCappedExpiration. Minutes. */
      expiration: {
        service: 'SlidingCappedExpiration',
        ttl: 30,
        maxLifetime: 480,
      },
    },
  },
};

export default sessionConfig;
