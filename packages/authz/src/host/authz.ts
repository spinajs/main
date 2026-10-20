import { DI } from '@spinajs/di';

import { AuthzConfigError } from '../contracts/errors.js';
import { AuthzDomains, ROOT_DOMAIN } from '../contracts/service.js';
import type { AuthzService } from '../contracts/service.js';
import { DefaultAuthzDomains } from './domains.js';

/** The resolved AuthzService of a domain. Synchronous: it never resolves anything itself. */
export function authz(domain: string = ROOT_DOMAIN): AuthzService {
  const name = typeof domain === 'string' ? JSON.stringify(domain) : String(domain);
  const domains: unknown = DI.RootContainer.get(AuthzDomains);
  if (!(domains instanceof DefaultAuthzDomains)) {
    throw new AuthzConfigError(`authz(${name}): the AuthzDomains singleton does not exist yet; await DI.resolve(AuthzService) first`);
  }
  const service = domains.resolved(domain);
  if (!service) {
    const how = domain === ROOT_DOMAIN ? 'DI.resolve(AuthzService)' : `AuthzDomains.service(${name})`;
    throw new AuthzConfigError(`authz(${name}): the AuthzService of domain ${name} is not resolved; await ${how} first`);
  }
  return service;
}
