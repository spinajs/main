const integer = (minimum: number, defaultValue: number) => ({ type: 'integer', minimum, default: defaultValue });

const ttlPair = (positive: number, negative: number) => ({
  type: 'object',
  default: {},
  additionalProperties: false,
  properties: { positive: integer(0, positive), negative: integer(0, negative) },
});

const SOURCE_NAME = '^[a-z0-9][a-z0-9_.-]{0,62}$';

export const DEFAULT_LIST_SOURCE = {
  name: 'disposable-email-domains',
  kind: 'block',
  format: 'lines',
  url: 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf',
};

export const EMAIL_VERIFICATION_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/email-verification.configuration.schema.json',
  $configurationModule: 'emailVerification',
  description: 'Email domain verification (emailVerification)',
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean', default: false },
    store: { type: 'string', minLength: 1, default: 'MemoryEmailVerificationStore' },
    verifiers: {
      type: 'array',
      minItems: 1,
      default: [{ service: 'ListVerifier' }, { service: 'DnsVerifier' }],
      items: { type: 'object', required: ['service'], properties: { service: { type: 'string', minLength: 1 } } },
    },
    timeoutMs: integer(1, 3000),
    onError: { enum: ['allow', 'refuse'], default: 'allow' },
    refuseCode: { type: 'string', pattern: '^[a-z0-9][a-z0-9_.-]{0,58}$', default: 'email_domain_refused' },
    lru: {
      type: 'object',
      default: {},
      additionalProperties: false,
      properties: { maxEntries: integer(0, 10000), ttlSeconds: integer(0, 300) },
    },
    lists: {
      type: 'object',
      default: {},
      additionalProperties: false,
      properties: {
        refreshSeconds: integer(1, 30),
        minKeepRatio: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        sources: {
          type: 'array',
          default: [DEFAULT_LIST_SOURCE],
          items: {
            type: 'object',
            required: ['name', 'url', 'kind'],
            additionalProperties: false,
            properties: {
              name: { type: 'string', pattern: SOURCE_NAME, not: { const: 'admin' } },
              url: { type: 'string', pattern: '^https://' },
              kind: { enum: ['block', 'allow', 'block-mx'] },
              format: { enum: ['lines', 'json'], default: 'lines' },
            },
          },
        },
      },
    },
    dns: {
      type: 'object',
      default: {},
      additionalProperties: false,
      properties: {
        servers: { type: 'array', default: [], items: { type: 'string', minLength: 1 } },
        timeoutMs: integer(1, 1500),
        tries: integer(1, 2),
        ttl: ttlPair(86400, 3600),
      },
    },
    rdap: {
      type: 'object',
      default: {},
      additionalProperties: false,
      properties: {
        bootstrapUrl: { type: 'string', pattern: '^https://', default: 'https://data.iana.org/rdap/dns.json' },
        requestTimeoutMs: integer(1, 2000),
        minAgeDays: integer(0, 7),
        maxLookups: integer(1, 4),
        rateLimitedTtlSeconds: integer(0, 3600),
        ttl: ttlPair(2592000, 3600),
      },
    },
    http: {
      type: 'object',
      default: {},
      additionalProperties: false,
      properties: {
        providers: {
          type: 'array',
          default: [],
          items: {
            type: 'object',
            required: ['name', 'url', 'resultPath'],
            additionalProperties: false,
            properties: {
              name: { type: 'string', pattern: SOURCE_NAME },
              url: { type: 'string', pattern: '^https://\\S*\\{domain\\}' },
              headers: { type: 'object', default: {}, additionalProperties: { type: 'string' } },
              resultPath: { type: 'string', minLength: 1 },
              refuseWhen: { type: 'array', minItems: 1, default: [true], items: { type: ['boolean', 'string', 'number'] } },
              reason: { type: 'string', pattern: '^[a-z0-9_]{1,64}$', default: 'refused_by_provider' },
              ttlSeconds: integer(0, 86400),
            },
          },
        },
      },
    },
    orm: {
      type: 'object',
      default: {},
      additionalProperties: false,
      properties: {
        connection: { type: 'string', minLength: 1, default: 'email-verification-connection' },
        cleanupIntervalMs: integer(1000, 600000),
      },
    },
    redis: { type: 'object', default: {} },
    dynamodb: {
      type: 'object',
      default: {},
      additionalProperties: false,
      properties: {
        table: { type: 'string', minLength: 3, default: 'email-verification' },
        config: { type: 'object', default: {} },
        createTable: { type: 'boolean', default: true },
      },
    },
  },
};
