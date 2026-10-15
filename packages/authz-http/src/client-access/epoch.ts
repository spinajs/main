import { createHash } from 'node:crypto';
import { Injectable } from '@spinajs/di';
import { ceilingHash, principalKey } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { ServerMiddleware } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import type * as express from 'express';

import { PRINCIPAL_MIDDLEWARE_ORDER } from '../principals/middleware.js';
import '../storage.js';

export const ACCESS_EPOCH_HEADER = 'X-Access-Epoch';

export const ACCESS_EPOCH_MIDDLEWARE_ORDER = PRINCIPAL_MIDDLEWARE_ORDER + 1;

/**
 * Changes when the principal's access may change while no authz data does (design §10.4): login, role
 * switch, MFA elevation and impersonation all rotate the session, which changes `authn.sessionHandle`.
 */
export function accessEpoch(principal: Principal): string {
  return createHash('sha256')
    .update(principalKey(principal) + (principal.authn?.sessionHandle ?? '') + ceilingHash(principal.ceiling))
    .digest('hex')
    .slice(0, 16);
}

@Injectable(ServerMiddleware)
export class AccessEpochMiddleware extends ServerMiddleware {
  constructor() {
    super();
    this.Order = ACCESS_EPOCH_MIDDLEWARE_ORDER;
  }

  // In before(): after() never runs for a matched controller route.
  public before(): (req: Request, res: express.Response, next: express.NextFunction) => void {
    return (req, res, next) => {
      const principal = req.storage.Principal;
      if (principal) res.setHeader(ACCESS_EPOCH_HEADER, accessEpoch(principal));
      next();
    };
  }

  public after(): null {
    return null;
  }
}
