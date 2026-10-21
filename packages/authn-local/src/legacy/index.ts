import { isBcrypt, verifyBcrypt } from './bcrypt.js';
import { isPbkdf2, verifyPbkdf2 } from './pbkdf2.js';

/** Foreign password hash formats that can be verified once and are then replaced by argon2 on login. */
export type LegacyHashKind = 'bcrypt' | 'pbkdf2';

export const LEGACY_HASH_KINDS: readonly LegacyHashKind[] = ['bcrypt', 'pbkdf2'];

/** The kind whose format `stored` has, or null; a malformed string is null. */
export function legacyKind(stored: string): LegacyHashKind | null {
  if (isBcrypt(stored)) return 'bcrypt';
  if (isPbkdf2(stored)) return 'pbkdf2';
  return null;
}

/** Never throws on a bad stored value. */
export function verifyLegacy(kind: LegacyHashKind, stored: string, password: string): Promise<boolean> {
  return kind === 'bcrypt' ? verifyBcrypt(stored, password) : verifyPbkdf2(stored, password);
}
