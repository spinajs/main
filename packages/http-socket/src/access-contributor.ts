import { DI, Injectable } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import type { IPolicyGroup } from '@spinajs/http';
import { AuthzContributor, parsePermission } from '@spinajs/authz';
import type { AuthzContribution, PermissionRefDecl } from '@spinajs/authz';
import { BaseSocketController } from './controller.js';
import { ISocketControllerDescriptor, SOCKET_CONTROLLER_DESCRIPTOR } from './interfaces.js';
import { ISocketAccess, SocketAccessPolicy } from './access.js';

/**
 * Feeds the permissions of every registered socket controller's `@SocketAccess` to boot rule 7 of the domain it checks
 * in, as authz-http's AccessContributor does for `@Access`: an unregistered permission fails that domain's boot ( B02 ).
 */
@Injectable(AuthzContributor)
export class SocketAccessContributor extends AuthzContributor {
  public contribute(domain: string): AuthzContribution {
    const permissionRefs: PermissionRefDecl[] = [];

    for (const type of new Set(DI.getRegisteredTypes(BaseSocketController) ?? [])) {
      const controller = type as Class<BaseSocketController>;
      const descriptor = Reflect.getMetadata(SOCKET_CONTROLLER_DESCRIPTOR, controller.prototype) as ISocketControllerDescriptor | undefined;
      if (!descriptor) {
        continue;
      }

      const scopes: Array<[string, readonly IPolicyGroup[]]> = [[`@SocketAccess on ${controller.name}`, descriptor.Policies], ...[...descriptor.Handlers.values()].map((h): [string, readonly IPolicyGroup[]] => [`@SocketAccess on ${controller.name}.${String(h.Method)}`, h.Policies])];

      for (const [source, groups] of scopes) {
        for (const member of groups.flat()) {
          const access = member.Type === SocketAccessPolicy ? (member.Options[0] as ISocketAccess) : undefined;
          if (!access || (access.domain ?? 'root') !== domain) {
            continue;
          }

          for (const permission of access.permissions) {
            // without an extractor the check runs on the type-level ref of the permission's resource
            permissionRefs.push(access.resource ? { permission, source } : { permission, type: parsePermission(permission).resource, source });
          }
        }
      }
    }

    return { permissionRefs };
  }
}
