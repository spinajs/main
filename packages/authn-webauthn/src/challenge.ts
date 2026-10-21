import type { IdentityRef } from '@spinajs/authn/contracts';

/** What a challenge was issued for: a credential registration, a passkey login, or the WebAuthn MFA step. */
export type WebAuthnCeremony = 'register' | 'login' | 'mfa';

export interface WebAuthnChallenge {
  /** base64url, 128 bits; names the challenge to the client. */
  readonly id: string;
  /** base64url, 256 bits; what the authenticator signs. */
  readonly challenge: string;
  readonly purpose: WebAuthnCeremony;
  /** The identity a registration or MFA challenge was issued to; absent for a login. */
  readonly identity?: IdentityRef;
  readonly expiresAt: Date;
}

/** Issued challenges until they are taken or expire. `DbWebAuthnChallengeStore` (`@spinajs/authn-webauthn/db`) shares them between processes. */
export abstract class WebAuthnChallengeStore {
  abstract put(c: WebAuthnChallenge): Promise<void>;
  /** Single use: the challenge once, then null; null as well when it is expired at `now`. */
  abstract take(id: string, now: Date): Promise<WebAuthnChallenge | null>;
}

/** In-process store for tests and single-process apps. */
export class MemoryWebAuthnChallengeStore extends WebAuthnChallengeStore {
  put(_c: WebAuthnChallenge): Promise<void> {
    throw new Error('not implemented: MemoryWebAuthnChallengeStore.put');
  }

  take(_id: string, _now: Date): Promise<WebAuthnChallenge | null> {
    throw new Error('not implemented: MemoryWebAuthnChallengeStore.take');
  }
}

/** A fresh challenge of `purpose`, live for `ttlSeconds` from `now`. */
export function newChallenge(_purpose: WebAuthnCeremony, _now: Date, _ttlSeconds: number, _identity?: IdentityRef): WebAuthnChallenge {
  throw new Error('not implemented: newChallenge');
}
