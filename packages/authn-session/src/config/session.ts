// Values (ttl, maxLifetime, pendingTtlSeconds, cookie) come from the authn schema defaults.
const sessionConfig = {
  authn: {
    session: {
      service: 'MemorySessionStore',

      /** Strategy by service name: AbsoluteExpiration | SlidingExpiration | SlidingCappedExpiration. */
      expiration: {
        service: 'SlidingCappedExpiration',
      },
    },
  },
};

export default sessionConfig;
