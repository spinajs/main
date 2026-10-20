import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

// setTimeout runs a longer delay after 1 ms
const MAX_TIMER_MS = 2 ** 31 - 1;

const positive = { type: 'number', exclusiveMinimum: 0 };
const positiveInteger = { type: 'integer', exclusiveMinimum: 0 };
const nonNegative = { type: 'number', minimum: 0 };
const timerMs = { ...positive, maximum: MAX_TIMER_MS };

/**
 * coerceTypes reads null and false as 0, which turns revalidation, the drain or recovery off, and true as 1 ms.
 * `if` sees the raw value before `properties` coerces it; `enum`, unlike `type`, coerces nothing. allOf keeps
 * the guards of one object apart, where spreading them would keep only the last.
 */
const neitherNullNorBoolean = (...keys: string[]) => ({
  allOf: keys.map((key) => ({ if: { properties: { [key]: { enum: [null, true, false] } }, required: [key] }, then: { properties: { [key]: false } } })),
});

export const SOCKET_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/http-socket.configuration.schema.json',
  $configurationModule: 'http.socket',
  description: 'Socket server configuration (http.socket.*)',
  type: 'object',
  required: ['rate', 'maxPayloadBytes', 'maxInFlightPerConnection', 'maxInFlightEventsPerConnection', 'auth', 'hooks', 'ordering', 'streams'],
  ...neitherNullNorBoolean('drainMs', 'pingInterval', 'pingTimeout'),
  properties: {
    path: { type: 'string', minLength: 1 },
    pingInterval: { ...positiveInteger, maximum: MAX_TIMER_MS },
    pingTimeout: { ...positiveInteger, maximum: MAX_TIMER_MS },
    drainMs: nonNegative,
    rate: { type: 'object', required: ['perSecond', 'burst'], properties: { perSecond: positive, burst: positive } },
    maxPayloadBytes: positiveInteger,
    maxInFlightPerConnection: positiveInteger,
    // a cap below the burst would drop events the rate limit lets through
    maxInFlightEventsPerConnection: { ...positiveInteger, minimum: { $data: '1/rate/burst' } },
    // `enum`: `type: 'boolean'` would coerce 'true', 1 and null
    auth: { type: 'object', required: ['revalidateMs'], properties: { required: { enum: [true, false] }, revalidateMs: nonNegative }, ...neitherNullNorBoolean('revalidateMs') },
    recovery: { type: 'object', properties: { maxDisconnectionMs: nonNegative }, ...neitherNullNorBoolean('maxDisconnectionMs') },
    // absent leaves socket.io's default
    transports: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['websocket', 'polling'] } },
    hooks: { type: 'object', required: ['connectTimeoutMs'], properties: { connectTimeoutMs: timerMs }, ...neitherNullNorBoolean('connectTimeoutMs') },
    ordering: { type: 'object', required: ['abortGraceMs'], properties: { abortGraceMs: timerMs }, ...neitherNullNorBoolean('abortGraceMs') },
    streams: { type: 'object', required: ['maxCredits', 'maxPerConnection', 'stallTimeoutMs'], properties: { maxCredits: positiveInteger, maxPerConnection: positiveInteger, stallTimeoutMs: { ...positiveInteger, maximum: MAX_TIMER_MS } } },
  },
};

registerConfigurationSchemaAtImport(SOCKET_CONFIGURATION_SCHEMA);

@Injectable(Bootstrapper)
export class SocketConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(SOCKET_CONFIGURATION_SCHEMA);
  }
}
