import type { Principal } from '@spinajs/authz';
import { Inject } from '@spinajs/di';

import { RbacService } from '../service.js';

/**
 * authz-http's `LinkResolver` (`principal(token, companion?)`) over RbacService.principalForToken.
 * authz-rbac does not depend on authz-http, so the class only matches that shape. authz-http
 * resolves `LinkResolver` from the root container: bind the instance registerRbac returns,
 * `DI.register(() => registered.linkResolver).as(LinkResolver)`. The `@Inject` form
 * (`DI.register(RbacLinkResolver).as(LinkResolver)`) needs `registerRbac(DI.RootContainer, …)`.
 */
@Inject(RbacService)
export class RbacLinkResolver {
  constructor(private readonly service: RbacService) {}

  principal(token: string, companion?: Principal): Promise<Principal> {
    return this.service.principalForToken(token, companion);
  }
}
