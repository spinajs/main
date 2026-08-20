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
 * ONE method, FOUR call sites - `createToken`, `grantTokenRole`,
 * `validateToken`, and the `GET user/tokens/roles` controller route (all
 * through the shared `_allowed_roles` helper in `src/actions.ts`). That is
 * deliberate: creation time and request time have to answer the same
 * question, otherwise a role a user was allowed to pick could be one their
 * token silently loses on the next request.
 *
 * `owner` is NOT hydrated the same way by every call site: `GET
 * user/tokens/roles` and `createToken` (from `POST user/tokens`) are handed
 * `req.storage.User` - the application's `User` subclass, with whatever
 * request-pipeline hydration already ran - while `grantTokenRole` and
 * `validateToken` are handed a base `User` with only `Metadata` populated
 * ( `_owner()` / a direct `User.where(...)` lookup, deliberately unscoped by
 * any application model override - see `_owner()`'s comments in
 * `src/actions.ts` ). A correct implementation MUST NOT rely on anything
 * beyond the base `User` model plus `Metadata` being present on `owner` -
 * that is the only shape all four call sites agree on. Any
 * application-specific field a policy reads may be populated on a
 * session-authenticated call and absent on a token-authenticated one,
 * answering the identical question two different ways.
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
   *
   * @param owner - at minimum a base `User` with `Metadata` populated; see the
   *                class docblock above for why nothing more may be assumed.
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
