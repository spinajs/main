export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

/** `authn.mfa.totp`, as the schema validates and defaults it. */
export interface TotpOptions {
  readonly issuer: string;
  readonly algorithm: TotpAlgorithm;
  readonly digits: number;
  readonly period: number;
  /** Time steps accepted on each side of the current one. */
  readonly window: number;
  /** Recovery codes issued at confirmation. */
  readonly recoveryCodes: number;
}
