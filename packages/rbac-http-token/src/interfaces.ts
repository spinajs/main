// Type-only import brings `@spinajs/rbac` into the program so the module
// augmentation at the bottom of this file has a module to attach to.
// Erased at runtime, so this stays a types-only file.
import type {} from '@spinajs/rbac';

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
 * `rbac.token.generation.service` - same pattern as `rbac.password.service`.
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

/**
 * Marker stored on request async storage when a request was authenticated
 * with an access token instead of a session.
 */
export interface ITokenAuthInfo {
  /**
   * Uuid of the AccessToken row - safe to log; never the token itself.
   */
  Uuid: string;
}

declare module '@spinajs/rbac' {
  interface IRbacAsyncStorage {
    /**
     * Set by TokenAuthMiddleware when the request carries a valid access token.
     */
    TokenAuth?: ITokenAuthInfo;
  }
}
