import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { InvalidArgument } from '@spinajs/exceptions';

import { toBytes } from './encoding.js';
import type { BinaryInput } from './encoding.js';

export type DigestEncoding = 'hex' | 'base64url' | 'buffer';

const isBinary = (v: unknown): v is BinaryInput => typeof v === 'string' || v instanceof Uint8Array;

function checkEncoding(enc: unknown): asserts enc is DigestEncoding {
  if (enc !== 'hex' && enc !== 'base64url' && enc !== 'buffer') {
    throw new InvalidArgument(`enc must be 'hex', 'base64url' or 'buffer'`, 'enc');
  }
}

function checkBinary(v: unknown, name: string): asserts v is BinaryInput {
  if (!isBinary(v)) {
    throw new InvalidArgument(`${name} must be a string or a Uint8Array`, name);
  }
}

const output = (digest: Buffer, enc: DigestEncoding): Buffer | string => (enc === 'buffer' ? digest : digest.toString(enc));

/** SHA-256 of `data` (strings as UTF-8), hex unless `enc` says otherwise. */
export function sha256(data: BinaryInput, enc: 'buffer'): Buffer;
export function sha256(data: BinaryInput, enc?: 'hex' | 'base64url'): string;
export function sha256(data: BinaryInput, enc: DigestEncoding = 'hex'): Buffer | string {
  checkBinary(data, 'data');
  checkEncoding(enc);
  return output(createHash('sha256').update(toBytes(data)).digest(), enc);
}

/** HMAC-SHA-256 of `data` under `key` (strings as UTF-8), hex unless `enc` says otherwise. */
export function hmacSha256(key: BinaryInput, data: BinaryInput, enc: 'buffer'): Buffer;
export function hmacSha256(key: BinaryInput, data: BinaryInput, enc?: 'hex' | 'base64url'): string;
export function hmacSha256(key: BinaryInput, data: BinaryInput, enc: DigestEncoding = 'hex'): Buffer | string {
  checkBinary(key, 'key');
  checkBinary(data, 'data');
  checkEncoding(enc);
  return output(createHmac('sha256', toBytes(key)).update(toBytes(data)).digest(), enc);
}

/**
 * First `len` hex characters of SHA-256(`${tag}\0${value}`): a domain-separated fingerprint, e.g. for logging an id
 * whose plain SHA-256 is a storage key. The tag must not contain NUL, so no two (tag, value) pairs share an input.
 */
export function taggedHash(tag: string, value: string, len = 64): string {
  if (typeof tag !== 'string' || tag.length === 0 || tag.includes('\0')) {
    throw new InvalidArgument('tag must be a non-empty string without NUL', 'tag');
  }
  if (typeof value !== 'string') {
    throw new InvalidArgument('value must be a string', 'value');
  }
  if (!Number.isInteger(len) || len < 1 || len > 64) {
    throw new InvalidArgument('len must be an integer from 1 to 64', 'len');
  }
  return createHash('sha256').update(`${tag}\0${value}`, 'utf8').digest('hex').slice(0, len);
}

/**
 * Constant-time comparison of the UTF-8 bytes of two strings. Only the length can show in the timing; false for a
 * non-string on either side.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Compares the SHA-256 digests of both sides in constant time, so neither the length nor the first differing byte
 * shows in the timing. False for a value that is neither a string nor a Uint8Array.
 */
export function timingSafeEqualDigest(a: BinaryInput, b: BinaryInput): boolean {
  if (!isBinary(a) || !isBinary(b)) {
    return false;
  }
  return timingSafeEqual(sha256(a, 'buffer'), sha256(b, 'buffer'));
}
