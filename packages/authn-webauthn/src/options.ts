/** `authn.webauthn`, as the schema validates and defaults it. */
export interface WebAuthnOptions {
  readonly rpId: string;
  readonly rpName: string;
  readonly origins: readonly string[];
  readonly userVerification: 'required' | 'preferred' | 'discouraged';
  readonly challengeTtlSeconds: number;
  readonly recoveryCodes: number;
}
