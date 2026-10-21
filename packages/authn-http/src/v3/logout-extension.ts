import type { Request } from '@spinajs/http';
import type { Session } from '@spinajs/authn/contracts';

/**
 * Registered with Array.ofType. `POST /auth/logout` calls every extension after it revoked the session; the first
 * redirect any of them answers sends the browser on (303), or is reported as `{ endSession }` to a script (200).
 */
export abstract class AuthnLogoutExtension {
  /** Runs after the session is revoked; the first redirect wins. */
  abstract afterLogout(session: Session, req: Request): Promise<{ readonly redirect?: string } | void>;
}
