interface BackoffParams {
  free: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

// Asymmetric JWS algorithms only: never 'none', never HMAC (design §22.9).
const JWT_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

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

function secretRef(description: string, extra: Record<string, object> = {}) {
  return {
    type: 'object',
    description: `${description} A reference the configuration resolves (e.g. aws-parameters://), never an inline value; null: not set.`,
    properties: { secret: { type: ['string', 'null'] }, ...extra },
    required: ['secret'],
  };
}

const named = {
  type: 'array',
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

// Defaults: the throttle is filled in whole, other objects only get their security floors, and only when present.
export const AUTHN_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authn.configuration.schema.json',
  $configurationModule: 'authn',
  description: 'Authentication configuration (authn.*, design §22.5)',
  type: 'object',
  properties: {
    config: {
      type: 'object',
      properties: {
        rejectLegacyKeys: { type: 'boolean', description: 'Fail boot on a 2.x key of the old-key table.' },
      },
    },
    strategies: { ...named, description: 'Strategy services by name.' },
    local: {
      type: 'object',
      properties: {
        hasher: {
          type: 'object',
          description: 'No argon2 cost keys: the cost is the library default (H30).',
          propertyNames: { enum: ['service', 'maxConcurrent'] },
          properties: {
            service: { type: 'string', minLength: 1 },
            maxConcurrent: { type: 'integer', minimum: 1, default: 8, description: 'Argon2 operations at once; the rest queue.' },
          },
        },
        pepper: secretRef('HMAC-SHA256 pepper applied before argon2.', {
          version: { type: 'integer', minimum: 1, description: 'Stored in the hash prefix so the pepper can rotate.' },
        }),
        policy: {
          type: 'object',
          properties: {
            minLength: { type: 'integer', minimum: 8, maximum: 128, default: 8, description: 'Passwords are 8–128 characters everywhere (A04).' },
            maxLength: { type: 'integer', minimum: 8, maximum: 128, default: 128 },
            rule: { type: ['object', 'null'], description: 'A JSON schema the password must match.' },
            blocklist: { type: ['string', 'null'], description: 'PasswordBlocklist service.' },
          },
        },
        generator: {
          type: 'object',
          properties: {
            length: { type: 'integer', minimum: 1 },
            characters: { ...stringList, minItems: 1, description: 'Concatenated into one pool.' },
          },
        },
        reset: {
          type: 'object',
          properties: {
            ttlSeconds: { type: 'integer', minimum: 1 },
            url: { type: 'string' },
            revokeTokens: { type: 'boolean', default: true },
          },
        },
        invite: {
          type: 'object',
          properties: {
            ttlSeconds: { type: 'integer', minimum: 1 },
          },
        },
        expiration: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            maxAgeDays: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    session: {
      type: 'object',
      properties: {
        service: { type: 'string', minLength: 1 },
        expiration: {
          type: 'object',
          description: 'Minutes.',
          properties: {
            service: { type: 'string', minLength: 1 },
            ttl: { type: 'integer', minimum: 1 },
            maxLifetime: { type: 'integer', minimum: 1 },
          },
        },
        pendingTtlSeconds: { type: 'integer', minimum: 1, description: 'Pre-MFA session (D25).' },
        cookie: {
          type: 'object',
          description: "'auto': on unless the env is development or test.",
          properties: {
            name: { type: 'string', minLength: 1 },
            // No `type`, so nothing is coerced: with coerceTypes a null would become false. String booleans (env values) are kept as given.
            hostPrefix: { enum: [true, false, 'auto', 'true', 'false'] },
            secure: { enum: [true, false, 'auto', 'true', 'false'] },
            // What the 2.x cookie builder and express accept: booleans and any letter case.
            sameSite: { anyOf: [{ enum: [true, false] }, { type: 'string', pattern: '^([Ss][Tt][Rr][Ii][Cc][Tt]|[Ll][Aa][Xx]|[Nn][Oo][Nn][Ee])$' }], default: 'strict' },
          },
        },
        hashIds: { type: 'boolean', enum: [true], default: true, description: 'Session ids are always stored hashed (SR-18); only true is accepted.' },
      },
    },
    mfa: {
      type: 'object',
      properties: {
        policy: {
          type: 'object',
          properties: {
            service: { type: 'string', minLength: 1 },
            force: { type: 'boolean' },
            forceForRoles: stringList,
          },
        },
        steps: { ...named, items: { ...named.items, properties: { ...named.items.properties, name: { type: 'string', minLength: 1, not: { enum: ['recovery'] }, description: "'recovery' is reserved for recovery codes (AuthnService.completeMfa)." } } } },
        encryptionKey: secretRef('AES-256-GCM key for stored MFA secrets; required when any step stores secrets.'),
        totp: {
          type: 'object',
          properties: {
            issuer: { type: 'string', minLength: 1 },
            algorithm: { type: 'string', minLength: 1, description: 'Any name otpauth accepts, e.g. SHA1 (authenticator apps), SHA256, SHA512.' },
            digits: { type: 'integer', minimum: 6, maximum: 10 },
            period: { type: 'integer', minimum: 1 },
            window: { type: 'integer', minimum: 0 },
            recoveryCodes: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    throttle: {
      type: 'object',
      default: {},
      propertyNames: { enum: ['service', 'login', 'mfa', 'reset', 'reauth', 'resetAfterSeconds', 'global'] },
      properties: {
        service: { type: 'string', minLength: 1 },
        login: flow({ free: 5, baseDelayMs: 1000, maxDelayMs: 60000 }, { free: 20, baseDelayMs: 1000, maxDelayMs: 300000 }),
        mfa: flow({ free: 3, baseDelayMs: 1000, maxDelayMs: 300000 }, { free: 20, baseDelayMs: 1000, maxDelayMs: 300000 }),
        reset: flow({ free: 1, baseDelayMs: 60000, maxDelayMs: 3600000 }, { free: 5, baseDelayMs: 10000, maxDelayMs: 900000 }),
        reauth: flow({ free: 3, baseDelayMs: 1000, maxDelayMs: 300000 }),
        resetAfterSeconds: { type: 'integer', minimum: 1, default: 86400, description: 'A key with no counted attempt for this long starts from zero.' },
        global: { ...backoff(), type: ['object', 'null'], default: null, description: 'Off (null) by default: one attacker could slow every login.' },
      },
    },
    freshAuth: {
      type: 'object',
      properties: {
        maxAgeSeconds: { type: 'integer', minimum: 1 },
      },
    },
    token: {
      type: 'object',
      properties: {
        prefix: { type: 'string', minLength: 1, description: 'Lets secret scanners recognise a leaked token.' },
        length: { type: 'integer', minimum: 32, description: 'Random bytes; at least 256 bits (A14).' },
        generation: {
          type: 'object',
          properties: {
            service: { type: 'string', minLength: 1 },
          },
        },
        maxTtlDays: { type: 'integer', minimum: 1, default: 90 },
        defaultTtlDays: { type: 'integer', minimum: 1 },
        agentMaxTtlMinutes: { type: 'integer', minimum: 1, default: 1440 },
        headerName: { type: 'string', minLength: 1 },
        lastUsedUpdateInterval: { type: 'integer', minimum: 0, description: 'Seconds.' },
      },
    },
    jwt: {
      type: 'object',
      properties: {
        issuers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              issuer: { type: 'string', minLength: 1 },
              audience: { type: 'string', minLength: 1 },
              jwksUri: { type: 'string', format: 'uri' },
              keys: { type: 'array', minItems: 1, items: { type: 'object' } },
              algorithms: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: JWT_ALGORITHMS } },
              clockSkewSeconds: { type: 'integer', minimum: 0, maximum: 60 },
              subjectClaim: { type: 'string', minLength: 1 },
              provider: { type: 'string', minLength: 1 },
            },
            required: ['issuer', 'audience', 'algorithms'],
            oneOf: [{ required: ['jwksUri'] }, { required: ['keys'] }],
          },
        },
      },
    },
    keys: {
      type: 'object',
      properties: {
        algorithms: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['EdDSA', 'ES256'] } },
        assertion: {
          type: 'object',
          properties: {
            typ: { type: 'string', minLength: 1 },
            audience: { type: ['string', 'null'] },
            maxLifetimeSeconds: { type: 'integer', minimum: 1, maximum: 300 },
            skewSeconds: { type: 'integer', minimum: 0 },
          },
        },
        httpSignature: {
          type: 'object',
          properties: {
            maxAgeSeconds: { type: 'integer', minimum: 1, maximum: 300 },
            requiredComponents: stringList,
          },
        },
      },
    },
    linking: {
      type: 'object',
      properties: {
        jit: { type: 'boolean' },
        byVerifiedEmail: { type: 'boolean' },
      },
    },
    impersonation: {
      type: 'object',
      properties: {
        requirePassword: { type: 'boolean', default: true },
        requireMfa: { type: 'boolean', default: true },
        maxMinutes: { type: 'integer', minimum: 1, default: 60 },
      },
    },
    audit: {
      type: 'object',
      properties: {
        sinks: stringList,
        sampleUse: { type: 'number', minimum: 0, maximum: 1 },
        hashIdentifiers: { type: 'boolean', default: true },
      },
    },
    http: {
      type: 'object',
      properties: {
        // Not a type union: with coerceTypes, 0 (trust no proxy) would become null (fall back).
        trustProxy: {
          anyOf: [
            { type: 'array', items: { type: 'string', minLength: 1 } },
            { type: 'integer', minimum: 0, nullable: true },
          ],
          description: 'Trusted proxy CIDRs or a hop count; null falls back to http.trustProxy. true coerces to 1 hop and false to 0, never to trust-all.',
        },
        csrf: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', default: true },
            allowedOrigins: { ...stringList, default: [], description: 'Besides the same origin, which is always allowed.' },
          },
        },
        routes: {
          type: 'object',
          properties: {
            prefix: { type: 'string' },
          },
        },
      },
    },
    oidc: {
      type: 'object',
      properties: {
        providers: {
          type: 'object',
          description: "Validated per provider by @spinajs/authn-oidc's own schema.",
          propertyNames: { pattern: '^[a-z0-9_-]{1,59}$' },
          additionalProperties: { type: 'object' },
        },
        redirects: {
          type: 'object',
          properties: {
            success: { type: 'string', pattern: '^/(?![/\\\\])' },
            failure: { type: 'string', pattern: '^/(?![/\\\\])' },
          },
        },
      },
    },
  },
};
