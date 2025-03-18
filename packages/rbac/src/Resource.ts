import { extractDecoratorDescriptor } from '@spinajs/orm';
import { IRbacModelDescriptor } from './interfaces.js';

/**
 * Assign resource name for given model ( RBAC ).
 * NOTE: this decorator is optional, if model does not have resource assigned
 *       model name will be used as default
 *
 * @param name - table name in database that is referred by this model
 */
export function OrmResource(resourceName: string) {
  return extractDecoratorDescriptor((model: IRbacModelDescriptor) => {
    model.RbacResource = resourceName;
  });
}
