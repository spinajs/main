// Type-only import brings `@spinajs/rbac` into the program so the module
// augmentation at the bottom of this file has a module to attach to.
// Erased at runtime, so this stays a types-only file.
import type {} from '@spinajs/rbac';
import type {} from '@spinajs/http';
// `@spinajs/rbac-http` is what puts User / Session / ActiveRole on the http
// request storage. Pulled in type-only so `req.storage.User` type-checks in a
// declaration build too, where nothing else drags that augmentation in.
import type {} from '@spinajs/rbac-http';

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

/**
 * The http request-local storage is a SEPARATE interface from rbac's
 * `IRbacAsyncStorage` ( `@spinajs/rbac-http` augments it the same way with
 * User / Session / ActiveRole ), so the marker has to be declared on both -
 * the one above for rbac's execution context, this one for `req.storage`.
 */
declare module '@spinajs/http' {
  interface IActionLocalStoregeContext {
    /**
     * Set by TokenAuthMiddleware when the request carries a valid access token.
     */
    TokenAuth?: ITokenAuthInfo;
  }
}
