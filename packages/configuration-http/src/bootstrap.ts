import { Bootstrapper, Injectable } from '@spinajs/di';
import { extractModelDescriptor } from '@spinajs/orm';
import { DbConfig } from '@spinajs/configuration-db-source';
import { IRbacModelDescriptor } from '@spinajs/rbac';

/**
 * Ties the `DbConfig` model to the `configuration` RBAC resource.
 *
 * `DbConfig` lives in the persistence-only `@spinajs/configuration-db-source`
 * package, which intentionally does not depend on rbac. Its `@Model('configuration')`
 * only names the database table - that is NOT the RBAC resource. Set the model's
 * `RbacResource` here ( this http package already depends on rbac ) so the
 * `RbacModelPermissionMiddleware` enforces `configuration` grants on every
 * DbConfig query, matching the route-level `@Resource('configuration')` on the
 * controller.
 *
 * Without this the model descriptor has no `RbacResource`, so model-level
 * permission checks are silently skipped ( the middleware's table-name fallback
 * is disabled ) and only the route-level policy would guard the data.
 */
@Injectable(Bootstrapper)
export class ConfigurationHttpBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    const descriptor = extractModelDescriptor(DbConfig) as IRbacModelDescriptor;
    if (descriptor) {
      descriptor.RbacResource = 'configuration';
    }
  }
}
