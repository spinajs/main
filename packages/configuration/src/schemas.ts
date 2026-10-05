import { DI, IContainer } from '@spinajs/di';
import { Configuration, IConfigurationSchema } from '@spinajs/configuration-common';

import { FrameworkConfiguration } from './configuration.js';

/**
 * Registers a configuration schema. When the Configuration of `container` already resolved, the schema is
 * applied at once; otherwise the Configuration applies it when it boots.
 */
export function registerConfigurationSchema(schema: IConfigurationSchema, container: IContainer = DI.RootContainer): void {
  container.register(schema).asValue('__configurationSchema__');
  const resolved = container.get(Configuration);
  if (resolved instanceof FrameworkConfiguration) resolved.validateModule(schema);
}
