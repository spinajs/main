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
    throttle: {
      type: 'object',
      default: {},
      description: 'Per-ip, per-route rate limiting (ThrottleMiddleware). Off by default: the authn throttle is the real login limiter.',
      properties: {
        enabled: { type: 'boolean', default: false },
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
  },
};
