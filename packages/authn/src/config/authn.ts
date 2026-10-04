// The config loader merges every .js under lib/*/config, so this folder holds this file only (no index barrel).
// Arrays concatenate across files, which is why no strategy or MFA step is listed here, and why authn.throttle.service
// is left to the package that ships the throttle to use (authn-orm: DbAuthnThrottle); unset, the only registered one
// runs. Values equal the schema and code defaults (test/boot/config-defaults.test.ts).
const authn = {
  authn: {
    strategies: [] as { name: string; service: string }[],
    mfa: {
      policy: {
        service: 'DefaultMfaPolicy',
        force: false,
        forceForRoles: [] as string[],
      },
    },
    throttle: {
      login: { account: { free: 5, baseDelayMs: 1000, maxDelayMs: 60000 }, ip: { free: 20, baseDelayMs: 1000, maxDelayMs: 300000 } },
      mfa: { account: { free: 3, baseDelayMs: 1000, maxDelayMs: 300000 }, ip: { free: 20, baseDelayMs: 1000, maxDelayMs: 300000 } },
      reset: { account: { free: 1, baseDelayMs: 60000, maxDelayMs: 3600000 }, ip: { free: 5, baseDelayMs: 10000, maxDelayMs: 900000 } },
      reauth: { account: { free: 3, baseDelayMs: 1000, maxDelayMs: 300000 } },
      resetAfterSeconds: 86400,
      global: null as null | { free: number; baseDelayMs: number; maxDelayMs: number },
    },
    freshAuth: {
      maxAgeSeconds: 300,
    },
    linking: {
      jit: false,
      byVerifiedEmail: false,
    },
    impersonation: {
      requirePassword: true,
      requireMfa: true,
      maxMinutes: 60,
    },
    audit: {
      sinks: ['LogAuthnAuditSink'],
      sampleUse: 0.01,
      hashIdentifiers: true,
      sinkTimeoutMs: 2000,
    },
    config: {
      rejectLegacyKeys: false,
    },
  },
};

export default authn;
