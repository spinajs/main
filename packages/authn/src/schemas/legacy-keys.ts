interface AuthnLegacyKeyBase {
  /** The 2.x path. */
  readonly from: string;
  /** 'subtree': `from` and every path below it move to `to` plus the same sub-path. */
  readonly scope: 'key' | 'subtree';
  /** The root that owns `to`. 'users' rows are listed because design §22.5's table lists them; the users detector owns them. */
  readonly family: 'authn' | 'users';
}

/** One 2.x key of design §22.5's old-key table, for the detector and the converter. */
export type AuthnLegacyKey =
  | (AuthnLegacyKeyBase & {
      readonly to: string;
      /** What the converter does beyond a rename. */
      readonly note?: string;
    })
  | (AuthnLegacyKeyBase & {
      /** Dropped: no 3.0 key. */
      readonly to: null;
      /** The detector's warning. */
      readonly note: string;
    });

const rows: AuthnLegacyKey[] = [
  { from: 'rbac.auth.service', to: 'authn.strategies', scope: 'key', family: 'authn', note: 'Becomes the `local` entry of authn.strategies (LocalPasswordStrategy).' },
  { from: 'rbac.password.service', to: 'authn.local.hasher.service', scope: 'key', family: 'authn' },
  { from: 'rbac.password.validation', to: 'authn.local.policy', scope: 'subtree', family: 'authn' },
  { from: 'rbac.password.generator', to: 'authn.local.generator', scope: 'subtree', family: 'authn' },
  { from: 'rbac.password.passwordResetWaitTime', to: 'authn.local.reset.ttlSeconds', scope: 'key', family: 'authn' },
  { from: 'rbac.password.invite.waitTime', to: 'authn.local.invite.ttlSeconds', scope: 'key', family: 'authn' },
  { from: 'rbac.password.resetUrl', to: 'authn.local.reset.url', scope: 'key', family: 'authn' },
  {
    from: 'rbac.password.blockAfterAttempts',
    to: 'authn.throttle.login.account.free',
    scope: 'key',
    family: 'authn',
    note: 'Attempts before the first delay. The converter has no off switch: 2.x 0 (no throttling) maps to the default `free` (H31).',
  },
  {
    from: 'rbac.password.lockoutTime',
    to: null,
    scope: 'key',
    family: 'authn',
    note: 'Dropped: 3.0 backs off and never locks (H31); delays are authn.throttle.<flow>.<key>.baseDelayMs and maxDelayMs.',
  },
  { from: 'rbac.password.expiration', to: 'authn.local.expiration', scope: 'subtree', family: 'authn', note: '`passwordExpirationTime` (seconds) becomes `maxAgeDays`.' },
  { from: 'rbac.session', to: 'authn.session', scope: 'subtree', family: 'authn' },
  { from: 'rbac.twoFactorAuth.enabled', to: 'authn.mfa.steps', scope: 'key', family: 'authn', note: 'true adds the totp step to authn.mfa.steps.' },
  { from: 'rbac.twoFactorAuth.forceUser', to: 'authn.mfa.policy.force', scope: 'key', family: 'authn' },
  { from: 'rbac.twoFactorAuth.service', to: 'authn.mfa.steps', scope: 'key', family: 'authn', note: 'The service of the totp step in authn.mfa.steps.' },
  { from: 'rbac.otpauth', to: 'authn.mfa.totp', scope: 'subtree', family: 'authn' },
  { from: 'rbac.token.prefix', to: 'authn.token.prefix', scope: 'key', family: 'authn' },
  { from: 'rbac.token.length', to: 'authn.token.length', scope: 'key', family: 'authn' },
  { from: 'rbac.token.generation', to: 'authn.token.generation', scope: 'subtree', family: 'authn' },
  { from: 'rbac.token.headerName', to: 'authn.token.headerName', scope: 'key', family: 'authn' },
  { from: 'rbac.token.lastUsedUpdateInterval', to: 'authn.token.lastUsedUpdateInterval', scope: 'key', family: 'authn' },
  { from: 'rbac.impersonation.requirePassword', to: 'authn.impersonation.requirePassword', scope: 'key', family: 'authn' },
  { from: 'rbac.user', to: 'users.user', scope: 'subtree', family: 'users' },
  { from: 'rbac.email', to: 'users.email', scope: 'subtree', family: 'users' },
  { from: 'rbac.actions', to: 'users.actions', scope: 'subtree', family: 'users' },
];

/** Design §22.5 "Old keys", one row per 2.x key, plus rbac.token.generation, which F0b moved too. The detector ships off (authn.config.rejectLegacyKeys); R1 turns it on. */
export const AUTHN_LEGACY_KEYS: readonly AuthnLegacyKey[] = Object.freeze(rows.map((r) => Object.freeze(r)));
