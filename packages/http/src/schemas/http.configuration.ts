import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { BOT_CONFIGURATION_SCHEMA } from '../bot/schema.js';

const nonEmpty = { type: 'string', minLength: 1 };

// Scheme, host and optional port; no path, query, credentials, wildcard, backslash or space. parseOrigin still normalises
// the entry (case, default port) and refuses what a pattern cannot judge (a port above 65535, a broken IPv6 literal).
const ORIGIN_PATTERN = '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#*@\\\\\\s]+/?$';

// anyOf with const null first: as a type union Ajv warns, and coerceTypes would turn null into '' or false.
const headerList = { anyOf: [{ type: 'array', items: { type: 'string' } }, { const: null }, { type: 'string' }] };
const positiveInteger = { type: 'integer', minimum: 1 };
const bodySize = { type: 'string', pattern: '^\\s*\\d+(\\.\\d+)?\\s*([bB]|[kKmMgG][bB])?\\s*$' };

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
        'Proxies in front of the app whose X-Forwarded-For counts (RealIp, the client address of every limiter; with @spinajs/authn-http a set authn.http.trustProxy wins): a hop count, or addresses, CIDRs and the names loopback, linklocal and uniquelocal (an array, or a comma-separated string). null or 0: no proxy. true coerces to one hop and false to none, never to trust-all. The first X-Forwarded-Proto and -Host value from a trusted proxy counts too, so that proxy must overwrite both headers.',
    },
    cors: {
      anyOf: [
        {
          type: 'object',
          properties: {
            origins: { type: ['array', 'null'], items: { anyOf: [{ const: '*' }, { type: 'string', pattern: ORIGIN_PATTERN }] } },
            exposedHeaders: headerList,
            allowedHeaders: headerList,
            allowRoutePolicies: { type: 'boolean', description: 'false: @Cors route policies are ignored. Default true.' },
          },
        },
        { const: null },
        { type: 'boolean' },
      ],
      description: 'Absent or falsy: only routes marked @Cors get CORS headers. Origins are listed as scheme://host[:port] or the one entry *.',
    },
    bodyLimits: {
      type: 'array',
      default: [],
      description:
        'Per-path request body limits, applied by BodyLimits (Order 3.4) just before the body parsers. The first rule whose path prefix (on a segment boundary, matched against the path the client requests) matches wins; other paths keep the http.bodyParsers limits.',
      items: {
        type: 'object',
        required: ['path', 'limit'],
        properties: {
          path: nonEmpty,
          limit: bodySize,
        },
      },
    },
    bodyParsers: {
      type: 'object',
      default: {},
      // propertyNames, not additionalProperties: the configuration's removeAdditional would drop a misspelt key silently
      propertyNames: { enum: ['json', 'urlencoded', 'text', 'cookies'] },
      description:
        'The built-in parser server middlewares: json (JsonBodyParser, limit 5mb), urlencoded (UrlencodedBodyParser), text (TextBodyParser, XML types, limit 5mb), all at Order 3.5, and cookies (CookieParserMiddleware, Order 0.5, signed with http.cookie.secret). Each takes enabled (default true) and the options of its express or cookie-parser function.',
      properties: Object.fromEntries(
        ['json', 'urlencoded', 'text', 'cookies'].map((kind) => [kind, { type: 'object', properties: { enabled: { enum: [true, false] }, limit: { anyOf: [{ type: 'integer', minimum: 0 }, bodySize] } } }]),
      ),
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
    routes: {
      type: 'object',
      default: {},
      properties: {
        // No item schema: a class entry is a function, which no JSON schema type accepts. Entries are checked at boot.
        middlewares: {
          type: 'array',
          default: [],
          description:
            'Route middlewares mounted on every route, before the controller and route @Middleware ones: a RouteMiddleware name, a RouteMiddleware class, or { service, options } with constructor options.',
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
              headers: { type: 'boolean', description: 'true: send X-RateLimit-* headers on every request the rule counts, the 429 included. Default false: the 429 carries only Retry-After.' },
            },
          },
        },
      },
    },
    maintenance: {
      type: 'object',
      default: {},
      description: 'MaintenanceMode: answers 503 with Retry-After to every request but the allowed paths. MaintenanceMode.enable() and disable() switch it at runtime.',
      properties: {
        enabled: { type: 'boolean', default: false },
        retryAfter: { type: 'integer', minimum: 0, default: 60, description: 'Seconds sent in Retry-After.' },
        allow: { type: 'array', default: [], items: { type: 'string', pattern: '^/' }, description: 'Path prefixes answered as usual, on a segment boundary, case-insensitively (health checks, an admin API).' },
        message: { ...nonEmpty, description: 'The error message of the 503 body.' },
      },
    },
    audit: {
      type: 'object',
      default: {},
      description: 'The Audit route middleware, mounted with @Middleware(Audit) or http.routes.middlewares. @Middleware(Audit, options) overrides these per route; its redact list adds to this one.',
      properties: {
        methods: { type: 'array', items: nonEmpty, description: 'HTTP methods audited, eg. ["POST", "PUT", "PATCH", "DELETE"]; unset audits every method.' },
        redact: {
          type: 'array',
          default: ['password', 'token', 'secret', 'authorization', 'cookie', 'card'],
          items: nonEmpty,
          description: 'Keys whose values are recorded as [redacted], matched as case-insensitive substrings at any depth of the body and the query. Replaces the default list.',
        },
        includeBody: { type: 'boolean', default: true },
        maxBodyBytes: { type: 'integer', minimum: 0, default: 16384, description: 'A larger body, as JSON after redaction, is left out and only its size recorded.' },
      },
    },
    concurrency: {
      type: 'object',
      default: {},
      description: 'ConcurrencyLimit: load shedding. A request over max requests served at once by this process is answered 503 with Retry-After.',
      properties: {
        enabled: { type: 'boolean', default: false },
        max: { type: 'integer', minimum: 1, default: 500, description: 'Requests served at once.' },
        retryAfter: { type: 'integer', minimum: 0, default: 1, description: 'Seconds sent in Retry-After.' },
      },
    },
    deadline: {
      type: 'object',
      default: {},
      description: 'RequestDeadline: a deadline for every request. When it passes, req.storage.signal aborts and a request nothing was sent for yet is answered 504.',
      properties: {
        enabled: { type: 'boolean', default: false },
        ms: { type: 'integer', minimum: 1, default: 30000, description: 'Milliseconds a request may take. @Deadline(ms) on a route can only shorten it.' },
      },
    },
    bot: BOT_CONFIGURATION_SCHEMA,
  },
};

registerConfigurationSchemaAtImport(HTTP_CONFIGURATION_SCHEMA);
