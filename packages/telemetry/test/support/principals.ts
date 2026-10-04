import { DI } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import type { Request } from '@spinajs/http';
import { PrincipalSource } from '@spinajs/authz-http';
import { userPrincipal } from '@spinajs/authz-testing';

/** `x-user: <id>` becomes `user:<id>`. Registered by class: DI never returns factory registrations from Array.ofType. */
export class HeaderPrincipalSource extends PrincipalSource {
  public readonly name = 'test-header';
  public readonly order = 0;

  public async authenticate(req: Request): Promise<Principal | null> {
    const id = req.headers['x-user'];
    return typeof id === 'string' && id.length > 0 ? userPrincipal(id) : null;
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
