// Type-only import brings `@spinajs/users` into the program so the module
// augmentation at the bottom of this file has a module to attach to, and
// brings in `User` for `AccessTokenRolePolicy` below.
import type { User } from '@spinajs/users';
import type {} from '@spinajs/http';

/**
 * Marker stored on request async storage when a request was authenticated
 * with an access token instead of a session.
 *
 * @deprecated 2.x API; use TokenService. R1 removes it.
 */
export interface ITokenAuthInfo {
  /**
   * Uuid of the AccessToken row - safe to log; never the token itself.
   */
  Uuid: string;

  /**
   * The profile (a role name) this token is pinned to, when it carries one.
   * Consumed by application row-scoping the way a session's ActiveRole is;
   * permission checks do NOT read it - they stay on the narrowed User.Role.
   */
  Profile?: string;
}

/**
 * Decides which roles a given owner may put on an access token.
 *
 * ONE method, FOUR call sites - `createToken`, `grantTokenRole`,
 * `validateToken`, and the `GET user/tokens/roles` controller route (all
 * through the shared `_allowed_roles` helper in `src/legacy/actions.ts`). That is
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
 * `src/legacy/actions.ts` ). A correct implementation MUST NOT rely on anything
 * beyond the base `User` model plus `Metadata` being present on `owner` -
 * that is the only shape all four call sites agree on. Any
 * application-specific field a policy reads may be populated on a
 * session-authenticated call and absent on a token-authenticated one,
 * answering the identical question two different ways.
 *
 * Replaceable via config `rbac.token.rolePolicy.service`, the same pattern
 * `authn.token.generation.service` uses for the token generator. The shipped
 * default ( `LegacyOwnRolesTokenRolePolicy` ) answers with the owner's own roles,
 * which is the behaviour this package had before the seam existed.
 *
 * @deprecated 2.x API; use TokenService. R1 removes it.
 */
export abstract class AccessTokenRolePolicy {
  /**
   * Roles `owner` may carry on a token. Also the set every one of their
   * existing tokens is re-intersected with on each authenticated request, so a
   * role dropped from this answer stops authorising immediately.
   *
   * With `profile` set the answer is relative to that profile - an application
   * policy may (and should) narrow it to roles the profile's own grants cover.
   * The shipped default ignores the argument.
   *
   * @param owner - at minimum a base `User` with `Metadata` populated; see the
   *                class docblock above for why nothing more may be assumed.
   * @param profile - the profile the token is (or will be) pinned to
   */
  public abstract allowedRoles(owner: User, profile?: string): Promise<string[]>;

  /**
   * Profiles `owner` may pin a token to. A profile plays the row-scoping part
   * a session's ActiveRole plays - see `ITokenAuthInfo.Profile`. Default: none;
   * an application that wants profile tokens overrides this in its policy.
   */
  public async allowedProfiles(_owner: User): Promise<string[]> {
    return [];
  }
}

declare module '@spinajs/users' {
  interface IRbacAsyncStorage {
    /**
     * Set by TokenAuthMiddleware when the request carries a valid access token.
     *
     * @deprecated 2.x API; use TokenService. R1 removes it.
     */
    TokenAuth?: ITokenAuthInfo;
  }
}

/**
 * The http request-local storage is a SEPARATE interface from rbac's
 * `IRbacAsyncStorage` ( `@spinajs/authn-http` augments it the same way with
 * User / Session / ActiveRole ), so the marker has to be declared on both -
 * the one above for rbac's execution context, this one for `req.storage`.
 */
declare module '@spinajs/http' {
  interface IActionLocalStoregeContext {
    /**
     * Set by TokenAuthMiddleware when the request carries a valid access token.
     *
     * @deprecated 2.x API; use TokenService. R1 removes it.
     */
    TokenAuth?: ITokenAuthInfo;
  }
}
