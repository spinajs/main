import { createHash } from 'node:crypto';
import { Injectable } from '@spinajs/di';
import { ceilingHash, principalKey } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { ServerMiddleware } from '@spinajs/http';
import type { IReplyContext } from '@spinajs/http';

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

/** Stamps every framework reply, error replies included, with the epoch of the principal as it is when the reply leaves. */
@Injectable(ServerMiddleware)
export class AccessEpochMiddleware extends ServerMiddleware {
  constructor() {
    super();
    this.Order = ACCESS_EPOCH_MIDDLEWARE_ORDER;
  }

  public async onAfter({ storage, res }: IReplyContext): Promise<void> {
    const principal = storage.Principal;
    if (principal) res.setHeader(ACCESS_EPOCH_HEADER, accessEpoch(principal));
  }
}
