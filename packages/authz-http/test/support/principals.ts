import { DI } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import type { Request } from '@spinajs/http';
import { userPrincipal, withAuthn } from '@spinajs/authz-testing';

import { PrincipalSource } from '../../src/index.js';

/**
 * `x-user: <id>` becomes `user:<id>`, signed in with session handle `x-session` when that header is set. Registered by
 * class: DI never returns factory registrations from Array.ofType.
 */
export class HeaderPrincipalSource extends PrincipalSource {
  public readonly name = 'test-header';
  public readonly order = 0;

  public async authenticate(req: Request): Promise<Principal | null> {
    const id = req.headers['x-user'];
    const session = req.headers['x-session'];
    if (typeof id !== 'string' || id.length === 0) return null;
    return typeof session === 'string' && session.length > 0 ? withAuthn(userPrincipal(id), { sessionHandle: session }) : userPrincipal(id);
  }
}

export function registerHeaderSource(): () => void {
  DI.register(HeaderPrincipalSource).as(PrincipalSource);
  return () => {
    DI.unregister(HeaderPrincipalSource);
    DI.uncache(HeaderPrincipalSource);
    DI.uncache(PrincipalSource);
  };
}
