import type { ISession, User } from '@spinajs/rbac';

/**
 * Per-request context handed to each {@link LogoutHandler} during logout.
 * The session may be null when the caller has no active session — handlers
 * should treat that as a no-op.
 */
export interface ILogoutContext {
  /** Raw signed session cookie value (already unsigned by the framework) */
  Ssid: string;

  /** Restored session, or null when none is active */
  Session: ISession | null;

  /** Logged-in user as resolved by RbacMiddleware */
  User: User;
}

/** Cookie operation a handler may attach to its response */
export interface ILogoutCookie {
  Name: string;
  Value: string;
  Options: Record<string, unknown>;
}

/** Response payload a handler returns when it takes ownership of the logout */
export interface ILogoutResult {
  /** Response body */
  Body?: unknown;

  /** Cookie operations to attach */
  Cookies?: ILogoutCookie[];
}

/**
 * Pluggable logout step. Handlers are resolved via `DI.resolve(Array.ofType(LogoutHandler))`
 * by the logout controller and executed in ascending Priority order. The first
 * handler that returns a non-null result takes ownership of the response — the
 * chain stops there. Returning null defers to the next handler.
 *
 * Built-ins:
 *  - {@link ImpersonationLogoutHandler} (priority 10) — when an impersonation
 *    is active, revert it and keep the session alive.
 *  - {@link DefaultLogoutHandler} (priority 999) — destroy the session and
 *    clear the ssid cookie.
 *
 * Register custom handlers with @Injectable(LogoutHandler). Choose a Priority
 * lower than 999 to run before the default session destruction.
 */
export abstract class LogoutHandler {
  /**
   * Lower runs first. Default 100. The default cleanup handler runs at 999;
   * pick a value below that to run before it.
   */
  public Priority: number = 100;

  public abstract handle(context: ILogoutContext): Promise<ILogoutResult | null>;
}
