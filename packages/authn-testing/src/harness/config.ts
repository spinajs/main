import type { BackoffParams, ThrottleParams } from './ports.js';

export type AppEnv = 'development' | 'test' | 'production' | 'staging';

type DeepPartial<T> = { readonly [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface JwtIssuerOverride {
  issuer: string;
  audience: string;
  jwksUri: string;
  algorithms: readonly string[];
  clockSkewSeconds: number;
  subjectClaim: 'sub';
  provider: string;
  /** The issuer's own JIT switch (K6); off when left out. */
  linking?: { jit: boolean };
}

/**
 * Semantic overrides of design §22.5 (authn.*) plus http.*; the factory applies them its own way.
 * Secrets are the value itself, not a secret ref. `local.policy.blocklist` installs a blocklist hook that refuses exactly these strings.
 * `linking.jit` and `linking.byVerifiedEmail` apply globally and to the provider under test. `session.expiration` means
 * SlidingCappedExpiration with these minutes. `throttle` merges over DEFAULT_THROTTLE.
 */
export interface ConfigOverrides {
  readonly env?: AppEnv;
  readonly authn?: DeepPartial<{
    strategies: readonly { name: string; service: string }[];
    local: {
      hasher: { maxConcurrent: number };
      pepper: { secret: string | null; version: number };
      policy: { minLength: number; maxLength: number; rule: object | null; blocklist: readonly string[] | null };
      reset: { ttlSeconds: number; revokeTokens: boolean };
      invite: { ttlSeconds: number };
    };
    session: { expiration: { ttl: number; maxLifetime: number }; pendingTtlSeconds: number };
    mfa: { policy: { force: boolean }; totp: { recoveryCodes: number } };
    throttle: Partial<ThrottleParams>;
    freshAuth: { maxAgeSeconds: number };
    token: { maxTtlDays: number; agentMaxTtlMinutes: number };
    jwt: { issuers: readonly JwtIssuerOverride[] };
    keys: { assertion: { maxLifetimeSeconds: number; skewSeconds: number } };
    linking: { jit: boolean; byVerifiedEmail: boolean };
    impersonation: { requirePassword: boolean; requireMfa: boolean; maxMinutes: number; clockSkewSeconds: number };
    http: { trustProxy: number | readonly string[] | null; csrf: { enabled: boolean; allowedOrigins: readonly string[] } };
  }>;
  readonly http?: { readonly cors?: { readonly origins?: readonly string[] | null } };
}

/** Design §22.5 values. */
export const DEFAULT_THROTTLE: ThrottleParams = Object.freeze({
  login: Object.freeze({ account: Object.freeze({ free: 5, baseDelayMs: 1000, maxDelayMs: 60000 }), ip: Object.freeze({ free: 20, baseDelayMs: 1000, maxDelayMs: 300000 }) }),
  mfa: Object.freeze({ account: Object.freeze({ free: 3, baseDelayMs: 1000, maxDelayMs: 300000 }), ip: Object.freeze({ free: 20, baseDelayMs: 1000, maxDelayMs: 300000 }) }),
  reset: Object.freeze({ account: Object.freeze({ free: 1, baseDelayMs: 60000, maxDelayMs: 3600000 }), ip: Object.freeze({ free: 5, baseDelayMs: 10000, maxDelayMs: 900000 }) }),
  reauth: Object.freeze({ account: Object.freeze({ free: 3, baseDelayMs: 1000, maxDelayMs: 300000 }) }),
  resetAfterSeconds: 86400,
  global: null,
});

export const UNTHROTTLED: BackoffParams = Object.freeze({ free: 1_000_000_000, baseDelayMs: 1, maxDelayMs: 1 });
