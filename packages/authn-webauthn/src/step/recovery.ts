import { createHash, randomBytes } from 'node:crypto';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { InvalidArgument } from '@spinajs/exceptions';
import { identityKey } from '@spinajs/authn-orm/identity';

/**
 * Recovery codes of the WebAuthn step, stored as SHA-256 only. `DbWebAuthnRecoveryCodeStore` keeps them in authn-orm's
 * `authn_recovery_code`, one set per identity, which the TOTP step shares: confirming either step replaces the set.
 */
export abstract class WebAuthnRecoveryCodeStore {
  /** Voids the old set; empty or repeated codes throw. */
  abstract replace(id: IdentityRef, rawCodes: readonly string[]): Promise<void>;
  /** Single use: true for exactly one caller. */
  abstract redeem(id: IdentityRef, raw: string): Promise<boolean>;
  abstract remove(id: IdentityRef): Promise<void>;
}

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export class MemoryWebAuthnRecoveryCodeStore extends WebAuthnRecoveryCodeStore {
  /** identity key -> code hash -> used */
  private readonly codes = new Map<string, Map<string, boolean>>();

  async replace(id: IdentityRef, rawCodes: readonly string[]): Promise<void> {
    const hashes = [...rawCodes].map((code) => {
      if (typeof code !== 'string' || code === '') throw new InvalidArgument('MemoryWebAuthnRecoveryCodeStore.replace: an empty code');
      return sha256hex(code);
    });
    if (new Set(hashes).size !== hashes.length) throw new InvalidArgument('MemoryWebAuthnRecoveryCodeStore.replace: the codes repeat');
    this.codes.set(identityKey(id), new Map(hashes.map((h) => [h, false])));
  }

  async redeem(id: IdentityRef, raw: string): Promise<boolean> {
    const set = this.codes.get(identityKey(id));
    if (!set || typeof raw !== 'string' || raw === '') return false;
    const hash = sha256hex(raw);
    if (set.get(hash) !== false) return false;
    set.set(hash, true);
    return true;
  }

  async remove(id: IdentityRef): Promise<void> {
    this.codes.delete(identityKey(id));
  }

  /** The stored hashes, for storage checks in tests. */
  hashes(id: IdentityRef): readonly string[] {
    return [...(this.codes.get(identityKey(id))?.keys() ?? [])];
  }
}

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

/** `count` distinct codes of 16 base32 chars, as stored and redeemed. */
export function newRecoveryCodeSet(count: number): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(base32(randomBytes(CODE_BYTES)));
  return [...codes];
}

/** `XXXX-XXXX-XXXX-XXXX`, the form shown to the owner. */
export const showRecoveryCode = (code: string): string => code.match(/.{4}/g)!.join('-');

/** Upper case without dashes and ASCII whitespace; null unless exactly 16 base32 chars remain. */
export function normaliseRecoveryCode(input: unknown): string | null {
  // Non-ASCII is refused before upper-casing, which would turn 'ß' into 'SS'.
  if (typeof input !== 'string' || !/^[\x20-\x7E\t\n\r]*$/.test(input)) return null;
  const code = input.toUpperCase().replace(/[-\s]/g, '');
  return CODE.test(code) ? code : null;
}
