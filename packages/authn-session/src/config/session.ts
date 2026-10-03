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

      /** Lifetime of a pending (pre-MFA) session, measured from issue and never extended by use. Seconds. */
      pendingTtlSeconds: 300,
    },
  },
};

export default sessionConfig;
