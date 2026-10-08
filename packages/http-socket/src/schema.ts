import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

const positive = { type: 'number', exclusiveMinimum: 0 };
const positiveInteger = { type: 'integer', exclusiveMinimum: 0 };
const nonNegative = { type: 'number', minimum: 0 };

export const SOCKET_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/http-socket.configuration.schema.json',
  $configurationModule: 'http.socket',
  description: 'Socket server configuration (http.socket.*)',
  type: 'object',
  required: ['rate', 'maxPayloadBytes', 'maxInFlightPerConnection', 'maxInFlightEventsPerConnection', 'auth', 'hooks', 'ordering', 'streams'],
  properties: {
    path: { type: 'string', minLength: 1 },
    pingInterval: positiveInteger,
    pingTimeout: positiveInteger,
    drainMs: nonNegative,
    rate: { type: 'object', required: ['perSecond', 'burst'], properties: { perSecond: positive, burst: positive } },
    maxPayloadBytes: positiveInteger,
    maxInFlightPerConnection: positiveInteger,
    // a cap below the burst would drop events the rate limit lets through
    maxInFlightEventsPerConnection: { ...positiveInteger, minimum: { $data: '1/rate/burst' } },
    auth: { type: 'object', required: ['revalidateMs'], properties: { required: { type: 'boolean' }, revalidateMs: nonNegative } },
    recovery: { type: 'object', properties: { maxDisconnectionMs: nonNegative } },
    // absent leaves socket.io's default
    transports: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['websocket', 'polling'] } },
    hooks: { type: 'object', required: ['connectTimeoutMs'], properties: { connectTimeoutMs: positive } },
    ordering: { type: 'object', required: ['abortGraceMs'], properties: { abortGraceMs: positive } },
    streams: { type: 'object', required: ['maxCredits', 'maxPerConnection', 'stallTimeoutMs'], properties: { maxCredits: positiveInteger, maxPerConnection: positiveInteger, stallTimeoutMs: { ...positiveInteger, maximum: 2 ** 31 - 1 } } },
  },
};

registerConfigurationSchemaAtImport(SOCKET_CONFIGURATION_SCHEMA);

@Injectable(Bootstrapper)
export class SocketConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(SOCKET_CONFIGURATION_SCHEMA);
  }
}
