export interface IGeneratedToken {
  /**
   * Full token as handed to the user, e.g. `spt_<base64url>`. Shown exactly once.
   */
  Plaintext: string;

  /**
   * SHA-256 hex digest of the plaintext - the only thing that is persisted.
   */
  Hash: string;
}

/**
 * Token generation algorithm. Replaceable via config
 * `authn.token.generation.service` - same pattern as `authn.local.hasher.service`.
 */
export abstract class AccessTokenGenerationProvider {
  /**
   * Generates a fresh token. Plaintext leaves the server once; only the hash is stored.
   */
  public abstract generate(): Promise<IGeneratedToken>;

  /**
   * Deterministic hash of a presented plaintext, used for DB lookup.
   */
  public abstract hash(plaintext: string): string;
}
