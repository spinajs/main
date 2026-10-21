import type { IdentityRef } from '@spinajs/authn/contracts';
import { Injectable, PerChildInstance } from '@spinajs/di';

import { WebAuthnCredentialStore } from '../contracts.js';
import type { WebAuthnCredential } from '../contracts.js';
import { WebAuthnChallengeStore } from '../challenge.js';
import type { WebAuthnChallenge } from '../challenge.js';
import { WebAuthnRecoveryCodeStore } from '../step/recovery.js';

/** `WebAuthnCredentialStore` on `authn_webauthn_credential`. Only the `@spinajs/authn-webauthn/db` entry loads it. */
@PerChildInstance()
@Injectable(WebAuthnCredentialStore)
export class DbWebAuthnCredentialStore extends WebAuthnCredentialStore {
  add(_c: WebAuthnCredential): Promise<void> {
    throw new Error('not implemented: DbWebAuthnCredentialStore.add');
  }

  get(_credentialId: string): Promise<WebAuthnCredential | null> {
    throw new Error('not implemented: DbWebAuthnCredentialStore.get');
  }

  listFor(_id: IdentityRef): Promise<readonly WebAuthnCredential[]> {
    throw new Error('not implemented: DbWebAuthnCredentialStore.listFor');
  }

  advance(_credentialId: string, _expected: number, _next: number, _at: Date): Promise<boolean> {
    throw new Error('not implemented: DbWebAuthnCredentialStore.advance');
  }

  remove(_id: IdentityRef, _credentialId: string): Promise<boolean> {
    throw new Error('not implemented: DbWebAuthnCredentialStore.remove');
  }
}

/** `WebAuthnChallengeStore` on `authn_webauthn_challenge`. */
@PerChildInstance()
@Injectable(WebAuthnChallengeStore)
export class DbWebAuthnChallengeStore extends WebAuthnChallengeStore {
  put(_c: WebAuthnChallenge): Promise<void> {
    throw new Error('not implemented: DbWebAuthnChallengeStore.put');
  }

  take(_id: string, _now: Date): Promise<WebAuthnChallenge | null> {
    throw new Error('not implemented: DbWebAuthnChallengeStore.take');
  }
}

/** `WebAuthnRecoveryCodeStore` on authn-orm's `authn_recovery_code`. */
@PerChildInstance()
@Injectable(WebAuthnRecoveryCodeStore)
export class DbWebAuthnRecoveryCodeStore extends WebAuthnRecoveryCodeStore {
  replace(_id: IdentityRef, _rawCodes: readonly string[]): Promise<void> {
    throw new Error('not implemented: DbWebAuthnRecoveryCodeStore.replace');
  }

  redeem(_id: IdentityRef, _raw: string): Promise<boolean> {
    throw new Error('not implemented: DbWebAuthnRecoveryCodeStore.redeem');
  }

  remove(_id: IdentityRef): Promise<void> {
    throw new Error('not implemented: DbWebAuthnRecoveryCodeStore.remove');
  }
}
