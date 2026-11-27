import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

export const RESPONSE_CACHE_DEFAULT_TIMEOUT_MS = 250;

const CACHE_HTTP_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/cache.http.configuration.schema.json',
  $configurationModule: 'cache.http',
  description: 'The response cache of @spinajs/cache-http (cache.http.*)',
  type: 'object',
  propertyNames: { enum: ['timeout'] },
  properties: {
    timeout: {
      type: 'integer',
      minimum: 1,
      default: RESPONSE_CACHE_DEFAULT_TIMEOUT_MS,
      description: 'Milliseconds the response cache waits for its cache to answer a lookup or a store; past it the request runs uncached; a store call that answers later may still store the reply. Default 250.',
    },
  },
};

registerConfigurationSchemaAtImport(CACHE_HTTP_CONFIGURATION_SCHEMA);
