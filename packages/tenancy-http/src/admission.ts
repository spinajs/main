import type { IContainer } from '@spinajs/di';
import { admitTenant } from '@spinajs/tenancy';
import type { TenantRecord, TenantResolver } from '@spinajs/tenancy';
import type { TenantRequestSource } from './source.js';

/**
 * The tenant the first proposal names, admitted for the source's principal; undefined when no resolver proposes one.
 * A resolver that is not trusted is asked only for an authenticated principal.
 *
 * @throws TenantUnavailable when the proposed tenant is unknown, not active or closed to the principal
 */
export async function resolveTenant(resolvers: readonly TenantResolver[], source: TenantRequestSource, container?: IContainer): Promise<TenantRecord | undefined> {
  const authenticated = source.principal?.authenticated === true;
  for (const resolver of resolvers) {
    if (!resolver.trusted && !authenticated) continue;
    const proposal = resolver.resolve(source);
    if (proposal !== undefined) return admitTenant(proposal, source.principal, container);
  }
  return undefined;
}
