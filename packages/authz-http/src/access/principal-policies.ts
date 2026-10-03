import { BasePolicy } from '@spinajs/http';
import type { Request } from '@spinajs/http';

import { unauthenticated } from './policy.js';
import '../storage.js';

/** Passes for any principal, anonymous included; 401 when the request has none. */
export class HasPrincipal extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: Request): Promise<void> {
    if (!req.storage.Principal) throw unauthenticated('this route needs a principal');
  }
}

/** Passes for an authenticated principal only; 401 otherwise. */
export class IsAuthenticated extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: Request): Promise<void> {
    if (!req.storage.Principal?.authenticated) throw unauthenticated('this route needs an authenticated principal');
  }
}
