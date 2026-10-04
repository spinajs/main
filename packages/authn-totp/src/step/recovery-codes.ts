import { randomBytes } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** 80 bits: the floor for codes stored as unsalted SHA-256. */
const CODE_BYTES = 10;
const CODE = /^[A-Z2-7]{16}$/;

function base32(bytes: Buffer): string {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(acc >> bits) & 31];
    }
  }
  return out;
}

/** A recovery code as stored and redeemed: 16 base32 chars. */
export function newRecoveryCode(): string {
  return base32(randomBytes(CODE_BYTES));
}

/** `XXXX-XXXX-XXXX-XXXX`, the form shown to the owner. */
export function showRecoveryCode(code: string): string {
  return code.match(/.{4}/g)!.join('-');
}

/** Upper case without dashes and whitespace; null unless exactly 16 base32 chars remain. */
export function normaliseRecoveryCode(input: unknown): string | null {
  if (typeof input !== 'string') {
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
