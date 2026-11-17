import type { Constructor } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import { register } from './registry.js';
import type { TenantModelOptions } from './registry.js';

/** Declares a model whose rows belong to one tenant. The model declares the tenant column itself (default `tenant_id`). */
export function Tenant(options?: TenantModelOptions): ClassDecorator {
  return (target) => {
    register(target, options, '@Tenant()');
  };
}

/** For models a package does not own. */
export function registerTenantModel(model: Constructor<ModelBase>, options?: TenantModelOptions): void {
  register(model, options, 'registerTenantModel()');
}
