import { InvalidArgument } from '@spinajs/exceptions';

const HEX = /^[0-9a-fA-F]*$/;
const B64 = /^[A-Za-z0-9+/]*$/;
const B64URL = /^[A-Za-z0-9_-]*$/;

/**
 * Reads a key of exactly `bytes` bytes (default 32) given as hex (either case), standard base64 (padded or not) or
 * base64url (unpadded). Unused low bits in the last base64 character must be zero, so one base64 text names one key.
 * Null for anything else; callers throw their own error, which must not quote the value.
 */
export function parseKeyMaterial(text: unknown, bytes = 32): Buffer | null {
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new InvalidArgument('bytes must be a positive integer', 'bytes');
  }
  if (typeof text !== 'string') {
    return null;
  }
  if (text.length === bytes * 2 && HEX.test(text)) {
    return Buffer.from(text, 'hex');
  }

  const unpadded = Math.ceil((bytes * 4) / 3);
  const body = text.slice(0, unpadded);
  const padding = text.slice(unpadded);
  const ok = padding === '' ? B64.test(body) || B64URL.test(body) : padding === '='.repeat((4 - (unpadded % 4)) % 4) && B64.test(body);
  if (!ok || body.length !== unpadded) {
    return null;
  }
  const canonical = body.replace(/\+/g, '-').replace(/\//g, '_');
  const key = Buffer.from(canonical, 'base64url');
  return key.length === bytes && key.toString('base64url') === canonical ? key : null;
}
