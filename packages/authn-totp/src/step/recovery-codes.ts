import { randomBytes } from 'node:crypto';
import { base32Encode } from '@spinajs/util/crypto';

/** 80 bits: the floor for codes stored as unsalted SHA-256. */
const CODE_BYTES = 10;
const CODE = /^[A-Z2-7]{16}$/;

/** A recovery code as stored and redeemed: 16 base32 chars. */
export function newRecoveryCode(): string {
  return base32Encode(randomBytes(CODE_BYTES));
}

/** `XXXX-XXXX-XXXX-XXXX`, the form shown to the owner. */
export function showRecoveryCode(code: string): string {
  return code.match(/.{4}/g)!.join('-');
}

/** Upper case without dashes and ASCII whitespace; null unless exactly 16 base32 chars remain. */
export function normaliseRecoveryCode(input: unknown): string | null {
  // Non-ASCII is refused before upper-casing, which would turn 'ß' into 'SS' and 'ı' into 'I'.
  if (typeof input !== 'string' || !/^[\x20-\x7E\t\n\r]*$/.test(input)) {
    return null;
  }
  const code = input.toUpperCase().replace(/[-\s]/g, '');
  return CODE.test(code) ? code : null;
}

/** `count` distinct codes. */
export function newRecoveryCodeSet(count: number): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    codes.add(newRecoveryCode());
  }
  return [...codes];
}
