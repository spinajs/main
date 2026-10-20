import { Injectable } from '@spinajs/di';
import { AuthzContributor, parsePermission } from '@spinajs/authz';
import type { AuthzContribution, PermissionRefDecl } from '@spinajs/authz';
import { bootSocketAccess } from './access.js';

/**
 * Feeds the permissions of every registered socket controller's `@SocketAccess` to boot rule 7 of the domain it checks
 * in, as authz-http's AccessContributor does for `@Access`: an unregistered permission fails that domain's boot ( B02 ).
 * Controllers registered after a domain booted are checked by its next boot only; `SocketServer` warns about them.
 */
@Injectable(AuthzContributor)
export class SocketAccessContributor extends AuthzContributor {
  public contribute(domain: string): AuthzContribution {
    const permissionRefs: PermissionRefDecl[] = [];

    for (const { source, access } of bootSocketAccess(domain)) {
      for (const permission of access.permissions) {
        // without an extractor the check runs on the type-level ref of the permission's resource
        permissionRefs.push(access.resource ? { permission, source } : { permission, type: parsePermission(permission).resource, source });
      }
    }

    return { permissionRefs };
  }
}
