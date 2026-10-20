import { Injectable } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import type { Request } from '@spinajs/http';

import { PrincipalSource } from '../api.js';
import '../storage.js';

/**
 * The principal authn-http resolved from a key, token or session and left in
 * `req.storage.AuthnPrincipal` (design §11.1, D26); a session still pending MFA leaves none.
 */
@Injectable(PrincipalSource)
export class AuthnPrincipalSource extends PrincipalSource {
  public readonly name = 'authn';
  public readonly order = 50;

  public async authenticate(req: Request): Promise<Principal | null> {
    return req.storage?.AuthnPrincipal ?? null;
  }
}
