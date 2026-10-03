import { DI, Injectable } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { AuthzContributor, parsePermission } from '@spinajs/authz';
import type { AuthzContribution, PermissionRefDecl } from '@spinajs/authz';
import { BaseController } from '@spinajs/http';

import { ACCESS_CLASS, accessDescriptorOf } from './descriptor.js';
import { extractorType } from './extractors.js';

/**
 * Feeds the permissions every registered controller's `@Access` names to boot rule 7 of the
 * domain it checks in (design §6.5): an unregistered permission, or one checked on a type outside
 * its types, fails that domain's boot (B02). Controllers registered after a domain booted are
 * checked by the next boot only.
 */
@Injectable(AuthzContributor)
export class AccessContributor extends AuthzContributor {
  public contribute(domain: string): AuthzContribution {
    const permissionRefs: PermissionRefDecl[] = [];

    for (const type of new Set(DI.getRegisteredTypes(BaseController) ?? [])) {
      const descriptor = accessDescriptorOf(type as Class<BaseController>);
      if (!descriptor) continue;

      for (const [key, rule] of descriptor.Access) {
        if ((rule.options.domain ?? 'root') !== domain) continue;
        const source = `@Access on ${(type as Class<unknown>).name}${key === ACCESS_CLASS ? '' : `.${String(key)}`}`;
        for (const permission of rule.permissions) {
          // Without an extractor the check runs on the type-level ref of the permission resource.
          const resourceType = rule.options.resource ? extractorType(rule.options.resource) : parsePermission(permission).resource;
          permissionRefs.push(resourceType === undefined ? { permission, source } : { permission, type: resourceType, source });
        }
      }
    }

    return { permissionRefs };
  }
}
