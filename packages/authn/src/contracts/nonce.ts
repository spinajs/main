/**
 * Single-use values (assertion jti, HTTP signature nonces, OIDC state) until they expire. `MemoryNonceStore` (core) and
 * `DbNonceStore` (authn-orm) implement it; the authn-keys strategies claim here too.
 */
export abstract class NonceStore {
  /** True exactly once while `key` is live: the first claim keeps it until `expiresAt`; an expired key may be claimed again. Keys over 160 chars throw.
   * `expiresAt` at or before `now` is never live, so such a claim is always true: callers refuse expired tokens first.
   */
  abstract claim(key: string, expiresAt: Date, now: Date): Promise<boolean>;
}
