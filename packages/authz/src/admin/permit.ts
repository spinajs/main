import { Configuration } from '@spinajs/configuration';

import { AuthzAdminFailure } from '../contracts/admin.js';
import type { AdminContext, AuthzCommand } from '../contracts/admin.js';
import type { Permission } from '../contracts/permission.js';
import { principalKey } from '../contracts/principal.js';
import type { Principal, ResourceRef } from '../contracts/principal.js';
import { resourceKey } from '../contracts/resource.js';
import type { AuthzService } from '../contracts/service.js';
import { mapPermission } from './config.js';
import type { AdminPermissionMap } from './config.js';
import { adminActor, adminContainer } from './context.js';

/** Allowed and unconditional, else AuthzAdminFailure('forbidden'): a command or a read has no row to evaluate a residual against. */
export async function requirePermitted(authz: AuthzService, actor: Principal, permission: Permission, resource: ResourceRef): Promise<void> {
  const d = await authz.check({ principal: actor, permission, resource });
  if (!d.allowed || d.residual?.op !== 'true') {
    const why = d.allowed ? 'only conditionally' : d.reason?.code ?? 'denied';
    throw new AuthzAdminFailure('forbidden', `${principalKey(actor)} may not ${permission} on ${resourceKey(resource)} (${why})`);
  }
}

/**
 * Checks the permission of `kind` at a second resource, exactly as AuthzAdmin checks the one its handler's
 * `permission()` names (mapped by authz.admin.permissions, else `fallback`). For a handler whose command also
 * reaches a resource other than that one, such as a row moved out of its old scope.
 */
export async function assertAdminPermission(ctx: AdminContext, kind: AuthzCommand['kind'], resource: ResourceRef, fallback: Permission): Promise<void> {
  const actor = adminActor(ctx);
  // A free function gets no @Config: it reads the section the schema validated from the domain container's Configuration.
  const configuration = (await adminContainer(ctx).resolve(Configuration)) as Configuration;
  const permissions = configuration.get<AdminPermissionMap>(['authz', 'admin', 'permissions'], {});
  await requirePermitted(ctx.authz, actor, mapPermission(permissions, kind, resource.type, fallback), resource);
}
