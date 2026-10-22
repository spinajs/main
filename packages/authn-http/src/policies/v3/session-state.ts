import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';

import { refused, unauthenticated } from './errors.js';

// Policies, not checks in the handler: they answer before the body is validated, as the handlers did before they took DTOs.

/** 401 without a session, 403 `mfa_not_pending` for an active one: the routes that complete a pending login. */
export class PendingSessionOnly extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request, _action: IRoute, _instance: IController): Promise<void> {
    const session = req.storage.AuthnSession;
    if (!session) throw unauthenticated('this route needs a pending session');
    if (session.handle.state !== 'pending') throw refused('mfa_not_pending', 'this session needs no second factor');
  }
}

/** 401 without a session, 403 `mfa_pending` for a pending one: the routes that raise an active session. */
export class ActiveSessionOnly extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request, _action: IRoute, _instance: IController): Promise<void> {
    const session = req.storage.AuthnSession;
    if (!session) throw unauthenticated('this route needs a session');
    if (session.handle.state !== 'active') throw refused('mfa_pending', 'complete the pending second factor instead');
  }
}
