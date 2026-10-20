import { createHmac } from 'node:crypto';

export interface PepperEntry {
  readonly secret: string;
  /** Stored in the hash prefix (`$sp<version>$`) so the pepper can rotate. */
  readonly version: number;
}

export interface ParsedStoredHash {
  /** Pepper version, or null when the hash has no pepper. */
  readonly version: number | null;
  /** The argon2 PHC string. */
  readonly argon2: string;
}

const ARGON2_ENCODED = /^\$argon2(?:id|i|d)\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;
const PEPPER_TAG = /^\$sp([1-9]\d{0,8})\$(\$.*)$/s;

/** The argon2 input under a pepper: the raw 32-byte HMAC-SHA256 of the password. */
export function pepperInput(password: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(password, 'utf8').digest();
}

export function formatStored(argon2: string, version: number | null): string {
  return version === null ? argon2 : `$sp${version}$${argon2}`;
}

/** Null for anything that is not an argon2 hash, optionally under a pepper tag. */
export function parseStored(stored: string): ParsedStoredHash | null {
  const tag = PEPPER_TAG.exec(stored);
  const version = tag ? Number(tag[1]) : null;
  const argon2 = tag ? tag[2] : stored;
  return ARGON2_ENCODED.test(argon2) ? { version, argon2 } : null;
}
