interface BackoffParams {
  free: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

function backoff(defaults?: BackoffParams) {
  return {
    type: 'object',
    description: 'After `free` counted attempts on a key, attempt n + 1 waits min(baseDelayMs × 2^(n − free), maxDelayMs) after attempt n. Never a lock (H31).',
    propertyNames: { enum: ['free', 'baseDelayMs', 'maxDelayMs'] },
    properties: {
      free: { type: 'integer', minimum: 0 },
      baseDelayMs: { type: 'integer', minimum: 0 },
      maxDelayMs: { type: 'integer', minimum: 1 },
    },
    required: ['free', 'baseDelayMs', 'maxDelayMs'],
    ...(defaults ? { default: defaults } : {}),
  };
}

function flow(account: BackoffParams, ip?: BackoffParams) {
  return {
    type: 'object',
    default: {},
    propertyNames: { enum: ['account', 'ip'] },
    properties: { account: backoff(account), ip: backoff(ip) },
  };
}

// 32 bytes as 64 hex characters, base64 (44 characters, or 43 unpadded) or base64url (43). The cipher also refuses a
// base64 text with non-zero unused bits in its last character, which a pattern cannot express.
const MFA_KEY_PATTERN = '^([0-9a-fA-F]{64}|[A-Za-z0-9+/]{43}=?|[A-Za-z0-9_-]{43})$';

export function secretRefSchema(description: string, extra: Record<string, object> = {}) {
  return {
    type: 'object',
    description: `${description} A reference the configuration resolves (e.g. aws-parameters://), never an inline value; null: not set.`,
    properties: { secret: { type: ['string', 'null'] }, ...extra },
    required: ['secret'],
  };
}

const named = {
  type: 'array',
  default: [],
  uniqueItemProperties: ['name'],
  items: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      service: { type: 'string', minLength: 1 },
    },
    required: ['name', 'service'],
  },
};

const stringList = { type: 'array', items: { type: 'string', minLength: 1 } };

// authn.local, jwt and mfa.totp, and the rest of session, token, keys and http, are fragment schemas of the packages that own them.
export const AUTHN_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authn.configuration.schema.json',
  $configurationModule: 'authn',
  description: 'Authentication configuration (authn.*, design §22.5)',
  type: 'object',
  properties: {
    strategies: { ...named, description: 'Strategy services by name, each name once. Config files concatenate arrays, so packages ship no entry and the app lists each strategy in one file.' },
    mfa: {
      type: 'object',
      default: {},
      properties: {
        policy: {
          type: 'object',
          default: {},
          properties: {
            service: { type: 'string', minLength: 1, default: 'DefaultMfaPolicy' },
            force: { type: 'boolean', default: false, description: "Requires a step on logins whose strategy reports method 'password' only (D13): key and OIDC logins get none." },
            forceForRoles: { ...stringList, default: [] },
          },
        },
        steps: { ...named, items: { ...named.items, properties: { ...named.items.properties, name: { type: 'string', minLength: 1, not: { enum: ['recovery'] }, description: "'recovery' is reserved for recovery codes (AuthnService.completeMfa)." } } } },
        encryptionKey: secretRefSchema('AES-256-GCM key for stored MFA secrets; required when any step stores secrets.', {
          secret: { type: ['string', 'null'], pattern: MFA_KEY_PATTERN, description: '32 bytes as 64 hex characters, base64 or base64url.' },
          previous: { type: 'array', items: { type: 'string', pattern: MFA_KEY_PATTERN }, description: 'Earlier keys, so rows written under them still decrypt after a rotation.' },
        }),
      },
      allOf: [
        // force and forceForRoles both require the first step, so there must be one (DefaultMfaPolicy). The `if` sees the
        // raw value, before coercion, so it lists the values Ajv coerces to true ('true', 1) and also '1', which Ajv does not
        // coerce and the type check refuses: its error then names the missing step too.
        {
          if: { type: 'object', required: ['policy'], properties: { policy: { type: 'object', required: ['force'], properties: { force: { enum: [true, 'true', 1, '1'] } } } } },
          then: { required: ['steps'], properties: { steps: { type: 'array', minItems: 1 } } },
        },
        {
          if: { type: 'object', required: ['policy'], properties: { policy: { type: 'object', required: ['forceForRoles'], properties: { forceForRoles: { type: 'array', minItems: 1 } } } } },
          then: { required: ['steps'], properties: { steps: { type: 'array', minItems: 1 } } },
        },
      ],
    },
    throttle: {
      type: 'object',
      default: {},
      propertyNames: { enum: ['service', 'login', 'mfa', 'reset', 'reauth', 'resetAfterSeconds', 'global', 'maxRows', 'memory'] },
      properties: {
        service: { type: 'string', minLength: 1 },
        login: flow({ free: 5, baseDelayMs: 1000, maxDelayMs: 60000 }, { free: 20, baseDelayMs: 1000, maxDelayMs: 300000 }),
        mfa: flow({ free: 3, baseDelayMs: 1000, maxDelayMs: 300000 }, { free: 20, baseDelayMs: 1000, maxDelayMs: 300000 }),
        reset: flow({ free: 1, baseDelayMs: 60000, maxDelayMs: 3600000 }, { free: 5, baseDelayMs: 10000, maxDelayMs: 900000 }),
        reauth: flow({ free: 3, baseDelayMs: 1000, maxDelayMs: 300000 }),
        resetAfterSeconds: { type: 'integer', minimum: 1, default: 86400, description: 'A key with no counted attempt for this long starts from zero.' },
        global: { ...backoff(), type: ['object', 'null'], default: null, description: 'Off (null) by default: one attacker could slow every login. Counted per flow: each flow keeps its own global row.' },
        maxRows: { type: 'integer', minimum: 4, maximum: 16000000, default: 1000000, description: 'Rows a MemoryAuthnThrottle keeps per flow (memory grows with 4 × maxRows).' },
        memory: {
          type: 'object',
          default: {},
          additionalProperties: false,
          // The app validator removes additional properties instead of refusing them; a typo must fail the boot.
          propertyNames: { enum: ['sweepBatch', 'fullRetrySeconds', 'holdOffMs'] },
          properties: {
            sweepBatch: { type: 'integer', minimum: 1, maximum: 1000, default: 8, description: 'Expired rows a MemoryAuthnThrottle checks per attempt.' },
            fullRetrySeconds: { type: 'integer', minimum: 1, maximum: 3600, default: 60, description: 'Retry-After of a full memory table with no delay to wait for.' },
            holdOffMs: { type: 'integer', minimum: 0, maximum: 60000, default: 1000, description: 'Pause before the next scan of a nearly full memory table.' },
          },
        },
      },
    },
    freshAuth: {
      type: 'object',
      default: {},
      properties: {
        maxAgeSeconds: { type: 'integer', minimum: 1, default: 300, description: 'A session authenticated this many seconds ago or less counts as fresh (A13).' },
      },
    },
    // The impersonation service reads maxLifetime; authn-session owns the rest of authn.session.
    session: {
      type: 'object',
      default: {},
      properties: {
        expiration: {
          type: 'object',
          default: {},
          description: 'Minutes.',
          properties: {
            maxLifetime: { type: 'integer', minimum: 1, default: 480 },
          },
        },
      },
    },
    // The credential wire format. authn-http's extractors read it without depending on authn-token or authn-keys, which
    // own the rest of authn.token and authn.keys.
    token: {
      type: 'object',
      default: {},
      properties: {
        prefix: { type: 'string', minLength: 1, default: 'spt_', description: 'Lets secret scanners recognise a leaked token.' },
        headerName: { type: 'string', minLength: 1, default: 'x-api-key' },
      },
    },
    keys: {
      type: 'object',
      default: {},
      properties: {
        assertion: {
          type: 'object',
          default: {},
          properties: {
            typ: { type: 'string', minLength: 1, default: 'spinajs-client+jwt' },
          },
        },
      },
    },
    linking: {
      type: 'object',
      default: {},
      properties: {
        jit: { type: 'boolean', default: false },
        byVerifiedEmail: { type: 'boolean', default: false },
      },
    },
    impersonation: {
      type: 'object',
      default: {},
      properties: {
        // Not `type: 'boolean'`: coerceTypes would turn a null into false and switch the check off.
        requirePassword: { enum: [true, false], default: true },
        requireMfa: { enum: [true, false], default: true },
        maxMinutes: { type: 'integer', minimum: 1, default: 60 },
        clockSkewSeconds: { type: 'integer', minimum: 0, maximum: 300, default: 30 },
      },
    },
    audit: {
      type: 'object',
      default: {},
      propertyNames: { enum: ['hashIdentifiers', 'hashKey', 'sinkTimeoutMs'] },
      properties: {
        // Not `type: 'boolean'`: coerceTypes would turn a null into false and write raw identifiers.
        hashIdentifiers: { enum: [true, false], default: true },
        hashKey: {
          ...secretRefSchema('HMAC key of LogAuthnAuditSink for hashed identifiers and of DbAuthnThrottle for its row keys; null: a random key per process, which DbAuthnThrottle refuses outside development and test.'),
          propertyNames: { enum: ['secret'] },
          properties: { secret: { type: ['string', 'null'], minLength: 32 } },
        },
        sinkTimeoutMs: { type: 'integer', minimum: 1, maximum: 60000, default: 2000, description: 'How long one sink may take.' },
      },
    },
    webhooks: {
      type: 'array',
      default: [],
      description: 'Outbound webhook sinks of authn-http: each target receives the audit events whose type is in `types` (all when absent), signed in Spinajs-Signature.',
      items: {
        type: 'object',
        required: ['url', 'secret'],
        propertyNames: { enum: ['url', 'secret', 'types', 'timeoutMs'] },
        properties: {
          url: { type: 'string', pattern: '^https?://[^\\s]+$' },
          secret: {
            type: 'object',
            description: 'A reference the configuration resolves (e.g. aws-parameters://), never an inline value.',
            propertyNames: { enum: ['secret'] },
            required: ['secret'],
            properties: { secret: { type: 'string', minLength: 1 } },
          },
          types: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
          timeoutMs: { type: 'integer', minimum: 1, maximum: 60000, default: 2000 },
        },
      },
    },
    // http-socket reads trustProxy without depending on authn-http, which owns the rest of authn.http.
    http: {
      type: 'object',
      default: {},
      properties: {
        // Not a type union: with coerceTypes, 0 (trust no proxy) would become null (fall back).
        trustProxy: {
          anyOf: [
            { type: 'array', items: { type: 'string', minLength: 1 } },
            { type: 'integer', minimum: 0, nullable: true },
          ],
          description: 'Trusted proxy CIDRs or a hop count; null falls back to http.trustProxy. true coerces to 1 hop and false to 0, never to trust-all.',
        },
      },
    },
  },
};
