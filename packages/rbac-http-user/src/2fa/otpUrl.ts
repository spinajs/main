import * as OTPAuth from 'otpauth';
import { InvalidArgument } from '@spinajs/exceptions';

export interface IOtpUrlOptions {
  issuer: string;
  label: string;
  algorithm: string;
  digits: number;
  period: number;
}

/**
 * Turns a raw base32 TOTP secret into a full `otpauth://` url that
 * authenticator apps ( eg. google authenticator ) understand. A value that is
 * already an `otpauth://` url is passed through untouched, so callers can
 * accept either form. Whitespace and case in the secret are normalized —
 * secrets are often shared in `jbsw y3dp ...` form.
 */
export function buildOtpAuthUrl(secretOrUrl: string, options: IOtpUrlOptions): string {
  const input = secretOrUrl.trim();

  if (!input) {
    throw new InvalidArgument('2fa secret or otpauth url is empty');
  }

  if (input.toLowerCase().startsWith('otpauth://')) {
    return input;
  }

  const secret = input.replace(/\s+/g, '').toUpperCase();

  return new OTPAuth.TOTP({
    issuer: options.issuer,
    label: options.label,
    algorithm: options.algorithm,
    digits: options.digits,
    period: options.period,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).toString();
}
