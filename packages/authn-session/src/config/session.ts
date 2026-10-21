// Values (ttl, maxLifetime, pendingTtlSeconds, touchThresholdSeconds, cookie) come from the authn schema defaults.
const sessionConfig = {
  authn: {
    session: {
      service: 'MemorySessionStore',
      allowMemoryStore: false,

      /** Strategy by service name: AbsoluteExpiration | SlidingExpiration | SlidingCappedExpiration. */
      expiration: {
        service: 'SlidingCappedExpiration',
      },
    },
  },
};

export default sessionConfig;
