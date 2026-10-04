import type { IdentityRef } from '@spinajs/authn/contracts';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { decryptMfaSecret, encryptMfaSecret, mfaKeyFrom } from './cipher.js';
import type { MfaKey } from './cipher.js';

/** `authn.mfa.encryptionKey`. */
export interface MfaEncryptionKeyOptions {
  readonly secret: string;
  /** Earlier keys, kept so rows written under them still decrypt after a rotation. */
  readonly previous?: readonly string[];
}

/** Writes under the current key; reads with the key whose id the row stores. */
export class MfaKeyRing {
  private readonly byId = new Map<string, MfaKey>();

  constructor(readonly current: MfaKey, previous: readonly MfaKey[] = []) {
    for (const key of [current, ...previous]) {
      if (!this.byId.has(key.keyId)) {
        this.byId.set(key.keyId, key);
      }
    }
  }

  encrypt(identity: IdentityRef | string, step: string, plain: string): { secretEnc: string; keyId: string } {
    return { secretEnc: encryptMfaSecret(this.current, identity, step, plain), keyId: this.current.keyId };
  }

  decrypt(identity: IdentityRef | string, step: string, secretEnc: string, keyId: string): string {
    const key = this.byId.get(keyId);
    if (!key) {
      throw new InvalidArgument(`MFA cipher: no configured key has the id ${JSON.stringify(String(keyId))}; add it to authn.mfa.encryptionKey.previous`);
    }
    return decryptMfaSecret(key, identity, step, secretEnc);
  }
}

export function mfaKeyRingFrom(options: MfaEncryptionKeyOptions): MfaKeyRing {
  if (typeof options !== 'object' || options === null || typeof options.secret !== 'string' || options.secret.length === 0) {
    throw new InvalidOption('authn.mfa.encryptionKey.secret is not set');
  }
  const previous = options.previous ?? [];
  if (!Array.isArray(previous)) {
    throw new InvalidOption('authn.mfa.encryptionKey.previous must be a list of keys');
  }
  return new MfaKeyRing(
    mfaKeyFrom(options.secret),
    previous.map((p) => mfaKeyFrom(p)),
  );
}
