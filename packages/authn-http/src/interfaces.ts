import type { User, ISession, PermissionType } from '@spinajs/users';

/**
 * Marker the legacy bridge stores on req.storage when a request carries a per-request credential (a token) instead of
 * a session.
 *
 * @deprecated The legacy bridge writes it; R1 deletes it with the bridge.
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

declare module '@spinajs/http' {
  interface IActionLocalStoregeContext {
    User: User | null;
    Session: ISession;

    /**
     * Controller route permission context
     * To check if we run from (read|update|insert|delete)Own or (read|update|insert|delete)Any scope
     *
     * eg. we want to read only current user data but it has admin privlidges too....
     */
    PermissionScope? : PermissionType;

    /**
     * Currently selected role from User.Role for the request. Defaults to the
     * first role in User.Role at login; can be changed via /auth/active-role.
     */
    ActiveRole?: string;

    /**
     * Original logged-in user when an impersonation is active. `User` then
     * holds the target user; `Impersonator` holds whoever initiated it.
     * Null/undefined on regular requests.
     */
    Impersonator?: User | null;

    /**
     * When set, RbacModelPermissionMiddleware skips injecting permission
     * constraints into query builders for this request.
     */
    SkipModelPermissionCheck?: boolean;

    /**
     * Set by the legacy bridge when the request carries a per-request credential (a token) instead of a session.
     *
     * @deprecated The legacy bridge writes it; R1 deletes it with the bridge.
     */
    TokenAuth?: ITokenAuthInfo;
  }
}
