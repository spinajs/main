import { NewInstance } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import type { Principal } from '@spinajs/authn/contracts';

import { refused, unauthenticated } from './errors.js';

/** The authenticated principal of the request, or a 401. */
export function authenticatedPrincipal(req: Request): Principal {
  const principal = req.storage.AuthnPrincipal;
  if (!principal || principal.authenticated !== true) throw unauthenticated('this route needs an authenticated caller');
  return principal;
}

// api.ts declares contract classes under the names of the three @NewInstance policies below, and DI keys classes by
// name: a singleton of either would be handed out for the other.

/** Only a session principal carries its hashed session handle; a per-request credential (token, JWT, key, signature) never does. */
export const isSessionPrincipal = (principal: Principal): boolean => typeof principal.authn?.sessionHandle === 'string' && principal.authn.sessionHandle !== '';

/** Passes when an authn principal exists; a pending (pre-MFA) session yields none and fails (D25, SR-07). Replaces LoggedPolicy and AuthorizedPolicy. */
export class Authenticated extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request, _action: IRoute, _instance: IController): Promise<void> {
    authenticatedPrincipal(req);
  }
}

/** Passes only when the request restored no session, active or pending. */
export class NoSession extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request, _action: IRoute, _instance: IController): Promise<void> {
    if (req.storage.AuthnSession) throw refused('session_exists', 'this route needs a request without a session');
  }
}

/** Passes only without an authn principal; a pending session passes, so a half-finished login can start over. */
@NewInstance()
export class NotLoggedPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request, _action: IRoute, _instance: IController): Promise<void> {
    if (req.storage.AuthnPrincipal) throw refused('already_authenticated', 'already logged in, log out first');
  }
}

/**
 * Fails when the authn principal came from a per-request credential (API token, JWT, key or signature): no credential mints or
 * manages credentials. Told apart by `authn.sessionHandle`, not by `authn.method`, which would need a list of every credential method.
 */
@NewInstance()
export class NoTokenAuthPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request, _action: IRoute, _instance: IController): Promise<void> {
    const principal = req.storage.AuthnPrincipal;
    if (principal && !isSessionPrincipal(principal)) throw refused('session_required', 'this route needs a session, not a per-request credential');
  }
}

/** Fails while impersonating (principal.authn.impersonator is set): routes that hand out lasting credentials need the account owner. */
@NewInstance()
export class NoImpersonationPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request, _action: IRoute, _instance: IController): Promise<void> {
    if (req.storage.AuthnPrincipal?.authn?.impersonator !== undefined) throw refused('impersonating', 'this route cannot be used while impersonating another user');
  }
}
