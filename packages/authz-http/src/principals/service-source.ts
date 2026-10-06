import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import type { Principal } from '@spinajs/authz';
import type { Request } from '@spinajs/http';

import { PrincipalSource } from '../api.js';
import { servicePrincipals } from '../http-config.js';
import type { ServiceEntry, ServicePrincipalConfig } from '../http-config.js';

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

// Equal-length digests, so neither the token's length nor its first differing byte shows in the timing.
const sameToken = (presented: string, expected: string) => timingSafeEqual(digest(presented), digest(expected));

function servicePrincipal(s: ServicePrincipalConfig): Principal {
  return Object.freeze({ type: 'service', id: s.name, authenticated: true, source: 'service', attributes: s.attributes });
}

/**
 * `service:<name>` for a request whose configured header carries one of the service's tokens
 * (`authz.http.services`, design §11.1). Runs before the authn principal (order 40 < 50), so a
 * configured service header wins over any authn credential. A wrong token yields nothing: the
 * header may be one other credentials share.
 */
@Injectable(PrincipalSource)
export class ServicePrincipalSource extends PrincipalSource {
  public readonly name = 'service';
  public readonly order = 40;

  @Config('authz.http.services')
  protected Services: readonly ServiceEntry[];

  public async authenticate(req: Request): Promise<Principal | null> {
    for (const service of servicePrincipals(this.Services)) {
      const presented = req.headers?.[service.header];
      if (typeof presented !== 'string' || presented.length === 0) {
        continue;
      }

      // Every token is compared, matched or not.
      const matches = service.tokens.map((t) => sameToken(presented, t));
      if (matches.includes(true)) {
        return servicePrincipal(service);
      }
    }

    return null;
  }
}
