// Type-only import brings `@spinajs/rbac` into the program so the module
// augmentation at the bottom of this file has a module to attach to, and
// brings in `User` for `AccessTokenRolePolicy` below.
import type { User } from '@spinajs/rbac';
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

/**
 * Decides which roles a given owner may put on an access token.
 *
 * ONE method, three call sites - `createToken`, `grantTokenRole` and
 * `validateToken`. That is deliberate: creation time and request time have to
 * answer the same question, otherwise a role a user was allowed to pick could
 * be one their token silently loses on the next request.
 *
 * Replaceable via config `rbac.token.rolePolicy.service`, the same pattern
 * `rbac.token.generation.service` uses for the token generator. The shipped
 * default ( `OwnRolesTokenRolePolicy` ) answers with the owner's own roles,
 * which is the behaviour this package had before the seam existed.
 */
export abstract class AccessTokenRolePolicy {
  /**
   * Roles `owner` may carry on a token. Also the set every one of their
   * existing tokens is re-intersected with on each authenticated request, so a
   * role dropped from this answer stops authorising immediately.
   */
  public abstract allowedRoles(owner: User): Promise<string[]>;
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
