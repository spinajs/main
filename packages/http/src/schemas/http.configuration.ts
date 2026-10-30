import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { BOT_CONFIGURATION_SCHEMA } from '../bot/schema.js';

const nonEmpty = { type: 'string', minLength: 1 };

// Scheme, host and optional port; no path, query, credentials, wildcard, backslash or space. parseOrigin still normalises
// the entry (case, default port) and refuses what a pattern cannot judge (a port above 65535, a broken IPv6 literal).
const ORIGIN_PATTERN = '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#*@\\\\\\s]+/?$';

// anyOf with const null first: as a type union Ajv warns, and coerceTypes would turn null into '' or false.
const headerList = { anyOf: [{ type: 'array', items: { type: 'string' } }, { const: null }, { type: 'string' }] };
const positiveInteger = { type: 'integer', minimum: 1 };

export const HTTP_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/http.configuration.schema.json',
  $configurationModule: 'http',
  description: 'HTTP server configuration (http.*)',
  type: 'object',
  properties: {
    cookie: {
      type: 'object',
      properties: {
        // The public default ships in the package config, so there is no schema default; absence is refused by the session code.
        secret: { ...nonEmpty, description: 'Signs cookies. The shipped value is public: set your own.' },
      },
    },
    // Not a type union: with coerceTypes, 0 (trust no proxy) would become null. The string branch refuses a string that is
    // only a number, because coerceTypes would otherwise turn -1 or 1.5 into the string "-1" and accept it.
    trustProxy: {
      anyOf: [
        { type: 'array', items: { type: 'string', minLength: 1 } },
        { type: 'integer', minimum: 0, nullable: true },
        { type: 'string', pattern: '^(?![+-]?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$)' },
      ],
      default: null,
      description:
        'Proxies in front of the app whose X-Forwarded-For counts (RealIp, and authn ClientIp when authn.http.trustProxy is null): a hop count, or addresses, CIDRs and the names loopback, linklocal and uniquelocal (an array, or a comma-separated string). null or 0: no proxy. true coerces to one hop and false to none, never to trust-all. The first X-Forwarded-Proto and -Host value from a trusted proxy counts too, so that proxy must overwrite both headers.',
    },
    cors: {
      anyOf: [
        {
          type: 'object',
          properties: {
            origins: { type: ['array', 'null'], items: { anyOf: [{ const: '*' }, { type: 'string', pattern: ORIGIN_PATTERN }] } },
            exposedHeaders: headerList,
            allowedHeaders: headerList,
          },
        },
        { const: null },
        { type: 'boolean' },
      ],
      description: 'Absent or falsy: no CORS middleware. Origins are listed as scheme://host[:port] or the one entry *.',
    },
    bodyLimits: {
      type: 'array',
      default: [],
      description:
        'Per-path request body limits, applied before http.middlewares. The first rule whose path prefix (on a segment boundary, matched against the path the client requests) matches wins; other paths keep the 5mb default.',
      items: {
        type: 'object',
        required: ['path', 'limit'],
        properties: {
          path: nonEmpty,
          limit: { type: 'string', pattern: '^\\s*\\d+(\\.\\d+)?\\s*([bB]|[kKmMgG][bB])?\\s*$' },
        },
      },
    },
    contractTesting: {
      type: 'object',
      default: {},
      description: 'Test mode: validates response bodies against the schemas of a registered contract validator (createTestApp contractTesting). Leave off in production.',
      properties: {
        enabled: { enum: [true, false], default: false },
        mode: { enum: ['throw', 'log'], default: 'throw', description: 'throw: a body that breaks its schema answers 500; log: it is only recorded.' },
      },
    },
    errors: {
      type: 'object',
      default: {},
      properties: {
        includeStack: { type: 'boolean', default: false, description: 'Adds the exception stack to error bodies. Ignored when configuration.isProduction is set.' },
        includeFields: {
          type: 'array',
          default: [],
          description: 'Own enumerable properties of an exception copied into its application/problem+json body as extension members. Names the body already defines are ignored.',
          items: nonEmpty,
        },
        handlers: {
          type: 'array',
          default: [],
          description: 'App-wide route error handlers ( ErrorHandlerService names ), run after the route and controller @OnError handlers, in this order.',
          items: { type: 'object', required: ['service'], properties: { service: nonEmpty } },
        },
      },
    },
    csrf: {
      type: 'object',
      default: {},
      description: 'CsrfGuard: an unsafe request that carries Origin, Sec-Fetch-Site or an ambient cookie must come from the own origin or an allowed one.',
      properties: {
        // Not `type: 'boolean'`: coerceTypes would turn a null into false and switch the guard off.
        enabled: { enum: [true, false], default: true },
        allowedOrigins: { type: 'array', default: [], items: { type: 'string', pattern: ORIGIN_PATTERN }, description: 'Besides the own origin, which is always allowed.' },
        exempt: {
          type: 'array',
          default: [],
          items: { type: 'string', pattern: '^/' },
          description: 'Route paths never checked, after http.controllers.route.prefix, matched as the router matches routes (:params allowed). Prefer @CsrfExempt() on routes you own.',
        },
        ambientCookies: { type: 'array', default: [], items: nonEmpty, description: 'Cookies browsers attach on their own: a request carrying one is checked even without Origin and Sec-Fetch-Site.' },
      },
    },
    throttle: {
      type: 'object',
      default: {},
      description: 'Per-ip, per-route rate limiting (ThrottleMiddleware). Off by default: the authn throttle is the real login limiter.',
      properties: {
        enabled: { type: 'boolean', default: false },
        ipv6Prefix: { type: 'integer', minimum: 16, maximum: 128, default: 64, description: 'An IPv6 client is counted per prefix of this many bits, so its addresses share one window; IPv4 is counted whole.' },
        rules: {
          type: 'array',
          default: [],
          description: 'The first rule whose path prefix (on a segment boundary) and methods match wins.',
          items: {
            type: 'object',
            required: ['path', 'limit', 'windowSeconds'],
            properties: {
              path: nonEmpty,
              methods: { type: 'array', items: nonEmpty },
              limit: positiveInteger,
              windowSeconds: positiveInteger,
            },
          },
        },
      },
    },
    bot: BOT_CONFIGURATION_SCHEMA,
  },
};

registerConfigurationSchemaAtImport(HTTP_CONFIGURATION_SCHEMA);
