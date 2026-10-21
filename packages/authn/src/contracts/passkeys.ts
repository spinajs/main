import type { AuthnContext, IdentityRef } from './credentials.js';

/** WebAuthn options for the browser (`PublicKeyCredential*OptionsJSON`) and the id of the challenge they carry. */
export interface PasskeyCeremony {
  readonly challengeId: string;
  readonly options: Readonly<Record<string, unknown>>;
}

/** A registered passkey as its owner sees it; never the public key. */
export interface PasskeyEntry {
  /** The credential id, base64url. */
  readonly id: string;
  readonly name?: string;
  readonly transports?: readonly string[];
  readonly createdAt: Date;
  readonly lastUsedAt?: Date;
}

export interface PasskeyRegistration {
  readonly challengeId: string;
  /** The browser's `RegistrationResponseJSON`, unparsed. */
  readonly response: unknown;
  readonly name?: string;
}

/** `invalid_response`: a wrong, used, expired or foreign challenge, or an attestation that does not verify. */
export type PasskeyRegisterResult = { readonly ok: true; readonly passkey: PasskeyEntry } | { readonly ok: false; readonly code: 'invalid_response' | 'duplicate' };

/**
 * The passkeys of an identity behind the passkey routes; authn-webauthn's WebAuthnPasskeyService. The caller requires
 * fresh auth before registrationOptions and register (A13) and acts only on the identity of its own session. Login
 * itself goes through AuthnService.authenticate with `{ kind: 'webauthn', challengeId, response }`.
 */
export abstract class PasskeyService {
  /**
   * Assertion options for a login. With `identity` (a pending session's), a challenge for the WebAuthn MFA step that
   * allows only that identity's credentials.
   */
  abstract challenge(ctx: AuthnContext, identity?: IdentityRef): Promise<PasskeyCeremony>;
  /** Creation options for a discoverable credential bound to `id`. */
  abstract registrationOptions(id: IdentityRef, ctx: AuthnContext): Promise<PasskeyCeremony>;
  abstract register(id: IdentityRef, registration: PasskeyRegistration, ctx: AuthnContext): Promise<PasskeyRegisterResult>;
  /** Oldest first. */
  abstract list(id: IdentityRef): Promise<readonly PasskeyEntry[]>;
  /** False when `id` holds no passkey with that credential id. */
  abstract remove(id: IdentityRef, credentialId: string, ctx: AuthnContext): Promise<boolean>;
}
