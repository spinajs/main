import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

export const RESPONSE_CACHE_DEFAULT_TIMEOUT_MS = 250;

export const RESPONSE_CACHE_DEFAULT_WAIT_TIMEOUT_MS = 5000;

const CACHE_HTTP_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/cache.http.configuration.schema.json',
  $configurationModule: 'cache.http',
  description: 'The response cache of @spinajs/cache-http (cache.http.*)',
  type: 'object',
  propertyNames: { enum: ['timeout', 'waitTimeout'] },
  properties: {
    timeout: {
      type: 'integer',
      minimum: 1,
      default: RESPONSE_CACHE_DEFAULT_TIMEOUT_MS,
      description: 'Milliseconds the response cache waits for its cache to answer a lookup or a store; past it the request runs uncached; a store call that answers later may still store the reply. Default 250.',
    },
    waitTimeout: {
      type: 'integer',
      minimum: 1,
      default: RESPONSE_CACHE_DEFAULT_WAIT_TIMEOUT_MS,
      description: 'Milliseconds a request that missed waits for a run of the same key by another request of this process; past it the request runs the route itself and may store its reply. Default 5000.',
    },
  },
};

registerConfigurationSchemaAtImport(CACHE_HTTP_CONFIGURATION_SCHEMA);
