import type { TotpOptions } from '../../../src/step/index.js';

export const TOTP_DEFAULTS: TotpOptions = Object.freeze({ issuer: 'SpinaJS', algorithm: 'SHA1', digits: 6, period: 30, window: 1, recoveryCodes: 10 });

export const totpOpts = (over: Partial<TotpOptions> = {}): TotpOptions => Object.freeze({ ...TOTP_DEFAULTS, ...over });
