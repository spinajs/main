import { DI } from '@spinajs/di';
import { registerConfigurationSchema } from '@spinajs/configuration';

export const BASIC_SCHEMA = {
  $id: 'spinajs/basic.configuration.schema.json',
  $configurationModule: 'basic',
  type: 'object',
  properties: { greeting: { type: 'string', default: 'hi' } },
};

DI.register({ version: 1 }).asValue('__basic_version__');
DI.register({ key: 'x' }).asMapValue('__basic_map__', 'key1');
registerConfigurationSchema(BASIC_SCHEMA);
