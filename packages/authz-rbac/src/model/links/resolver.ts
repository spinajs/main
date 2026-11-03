import { LinkResolver } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { Inject } from '@spinajs/di';

import { RbacService } from '../service.js';

/** The `LinkResolver` over RbacService.principalForToken; an RbacModel built by DI registers it in its domain's container. */
@Inject(RbacService)
export class RbacLinkResolver extends LinkResolver {
  constructor(private readonly service: RbacService) {
    super();
  }

  principal(token: string, companion?: Principal): Promise<Principal> {
    return this.service.principalForToken(token, companion);
  }
}
