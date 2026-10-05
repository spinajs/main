import { DI, IContainer } from '@spinajs/di';
import { Configuration, IConfigurationSchema } from '@spinajs/configuration-common';

import { FrameworkConfiguration } from './configuration.js';

/**
 * Registers a configuration schema. When the Configuration that `container` reads (the one of the nearest
 * container in its lineage that registers a Configuration) is already resolved, the schema is validated against
 * it at once; a Configuration that is registered but not resolved yet applies the schema when it boots.
 */
export function registerConfigurationSchema(schema: IConfigurationSchema, container: IContainer = DI.RootContainer): void {
  container.register(schema).asValue('__configurationSchema__');

  let owner: IContainer | undefined = container;
  while (owner && !owner.Registry.ownsRegistration(Configuration)) owner = owner.Parent;

  const resolved = owner?.get(Configuration, false);
  if (resolved instanceof FrameworkConfiguration) resolved.validateModule(schema);
}
