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

      /** `'auto'`: Secure and `__Host-` on unless the app env is development or test. */
      cookie: {
        name: 'ssid',
        hostPrefix: 'auto',
        secure: 'auto',
        sameSite: 'strict',
      },
    },
  },
};

export default sessionConfig;
