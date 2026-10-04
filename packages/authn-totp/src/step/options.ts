import { InvalidOption } from '@spinajs/exceptions';

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

/** `authn.mfa.totp` after defaults. */
export interface TotpOptions {
  readonly issuer: string;
  readonly algorithm: TotpAlgorithm;
  readonly digits: number;
  /** Seconds, at most MAX_PERIOD. */
  readonly period: number;
  /** Time steps accepted on each side of the current one, at most MAX_WINDOW. */
  readonly window: number;
  /** Recovery codes issued at confirmation, at most MAX_RECOVERY_CODES. */
  readonly recoveryCodes: number;
}

export type TotpOptionsInput = Partial<TotpOptions>;

export const DEFAULT_TOTP_OPTIONS: TotpOptions = Object.freeze({ issuer: 'SpinaJS', algorithm: 'SHA1', digits: 6, period: 30, window: 1, recoveryCodes: 10 });

const ALGORITHMS: readonly string[] = ['SHA1', 'SHA256', 'SHA512'];

/** A wider window or a longer period lets one guess or one stolen code cover too much time (SR-15). */
export const MAX_WINDOW = 10;
export const MAX_PERIOD = 300;
/** Every confirmation and regeneration builds and hashes the whole set. */
export const MAX_RECOVERY_CODES = 100;

const fail = (what: string): never => {
  throw new InvalidOption(`authn.mfa.totp: ${what}`);
};

const integer = (v: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fail(`${name} must be an integer from ${min} to ${max}`));

/** Defaults under `input`; throws `InvalidOption` on a value outside the allowed range. Unknown keys are ignored. */
export function totpOptions(input: TotpOptionsInput = {}): TotpOptions {
  const o = { ...DEFAULT_TOTP_OPTIONS, ...input };
  if (typeof o.issuer !== 'string' || o.issuer.length === 0) {
    fail('issuer must be a non-empty string');
  }
  if (!ALGORITHMS.includes(o.algorithm)) {
    fail(`algorithm must be one of ${ALGORITHMS.join(', ')}`);
  }
  return Object.freeze({
    issuer: o.issuer,
    algorithm: o.algorithm,
    digits: integer(o.digits, 'digits', 6, 10),
    period: integer(o.period, 'period', 1, MAX_PERIOD),
    window: integer(o.window, 'window', 0, MAX_WINDOW),
    recoveryCodes: integer(o.recoveryCodes, 'recoveryCodes', 0, MAX_RECOVERY_CODES),
  });
}
