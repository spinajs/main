interface BackoffParams {
  free: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

// Scheme, host and optional port; no path, query, credentials, wildcard, backslash or space. Consumers still normalise it with
// @spinajs/http's parseOrigin, which also refuses a port above 65535 and a broken IPv6 literal.
const ORIGIN_PATTERN = '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#*@\\\\\\s]+/?$';

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

// 32 bytes as 64 hex characters, base64 (44 characters, or 43 unpadded) or base64url (43). The cipher also refuses a
// base64 text with non-zero unused bits in its last character, which a pattern cannot express.
const MFA_KEY_PATTERN = '^([0-9a-fA-F]{64}|[A-Za-z0-9+/]{43}=?|[A-Za-z0-9_-]{43})$';

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

const JWT_ISSUER_MEMBERS = ['issuer', 'audience', 'jwksUri', 'keys', 'algorithms', 'clockSkewSeconds', 'subjectClaim', 'provider', 'linking'];
// A private or symmetric member: never part of a verification key.
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

const PUBLIC_JWK = {
  type: 'object',
  required: ['kty'],
  properties: {
    kty: { enum: ['RSA', 'EC', 'OKP'] },
    use: { const: 'sig' },
    // A key that may also sign or encrypt is shared with another use (RFC 7517 section 4.3).
    key_ops: { type: 'array', minItems: 1, maxItems: 1, items: { const: 'verify' } },
    ext: { type: 'boolean' },
    // From the key, up to the issuer: key -> keys -> issuer.
    alg: { enum: { $data: '3/algorithms' } },
  },
  not: { anyOf: PRIVATE_JWK_MEMBERS.map((member) => ({ required: [member] })) },
};

// Defaults: the throttle is filled in whole, other objects only get their defaults and floors when present (no `authn.local` tree for an app without authn-local).
export const AUTHN_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authn.configuration.schema.json',
  $configurationModule: 'authn',
  description: 'Authentication configuration (authn.*, design §22.5)',
  type: 'object',
  properties: {
    config: {
      type: 'object',
      default: {},
      properties: {
        rejectLegacyKeys: { type: 'boolean', default: false, description: 'Fail boot on a 2.x key of the old-key table.' },
      },
    },
    strategies: { ...named, description: 'Strategy services by name, each name once. Config files concatenate arrays, so packages ship no entry and the app lists each strategy in one file.' },
    local: {
      type: 'object',
      properties: {
        hasher: {
          type: 'object',
          default: {},
          description: 'No argon2 cost keys: the cost is the library default (H30).',
          propertyNames: { enum: ['service', 'maxConcurrent'] },
          properties: {
            service: { type: 'string', minLength: 1 },
            maxConcurrent: { type: 'integer', minimum: 1, default: 8, description: 'Argon2 operations at once; the rest queue.' },
          },
        },
        pepper: {
          ...secretRef('HMAC-SHA256 pepper applied before argon2.', {
            // An empty pepper would add nothing while looking set.
            secret: { type: ['string', 'null'], minLength: 1 },
            version: { type: 'integer', minimum: 1, maximum: 999999999, default: 1, description: 'Stored in the hash prefix so the pepper can rotate.' },
            previous: {
              type: 'array',
              description: 'Older peppers, so a hash made under one still verifies and is rehashed (A03). Each version differs from the others and from `version`.',
              uniqueItemProperties: ['version'],
              items: {
                type: 'object',
                properties: {
                  secret: { type: 'string', minLength: 1 },
                  // 3/version: up from the item's version (1), the item (2) and the previous list (3) to the pepper's own version.
                  version: { type: 'integer', minimum: 1, maximum: 999999999, not: { const: { $data: '3/version' } } },
                },
                required: ['secret', 'version'],
              },
            },
          }),
          default: { secret: null, version: 1 },
        },
        policy: {
          type: 'object',
          default: {},
          properties: {
            minLength: { type: 'integer', minimum: 8, maximum: 128, default: 8, description: 'Passwords are 8–128 characters everywhere (A04).' },
            maxLength: { type: 'integer', minimum: { $data: '1/minLength' }, maximum: 128, default: 128 },
            rule: { type: ['object', 'null'], default: null, description: 'A JSON schema the password must match.' },
            description: { type: 'string' },
            blocklist: { type: ['string', 'null'], default: null, description: 'PasswordBlocklist service.' },
          },
        },
        generator: {
          type: 'object',
          default: {},
          properties: {
            length: { type: 'integer', minimum: 1, default: 16 },
            characters: { ...stringList, minItems: 1, default: ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'], description: 'Concatenated into one pool.' },
          },
        },
        reset: {
          type: 'object',
          default: {},
          properties: {
            ttlSeconds: { type: 'integer', minimum: 1, default: 3600 },
            url: { type: 'string', default: '' },
            // Not `type: 'boolean'`: coerceTypes would turn a null into false and keep every API token after a reset.
            revokeTokens: { enum: [true, false], default: true },
          },
        },
        invite: {
          type: 'object',
          default: {},
          properties: {
            ttlSeconds: { type: 'integer', minimum: 1, default: 900 },
          },
        },
        expiration: {
          type: 'object',
          default: {},
          properties: {
            enabled: { type: 'boolean', default: false },
            maxAgeDays: { type: 'number', exclusiveMinimum: 0, default: 31 },
          },
        },
      },
    },
    session: {
      type: 'object',
      default: {},
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
          default: {},
          description: "'auto': on unless the env is development or test.",
          properties: {
            name: { type: 'string', minLength: 1, default: 'ssid' },
            // No `type`, so nothing is coerced: with coerceTypes a null would become false. String booleans (env values) are kept as given.
            hostPrefix: { enum: [true, false, 'auto', 'true', 'false'], default: 'auto' },
            secure: { enum: [true, false, 'auto', 'true', 'false'], default: 'auto' },
            // What the 2.x cookie builder and express accept: booleans and any letter case.
            sameSite: { anyOf: [{ enum: [true, false] }, { type: 'string', pattern: '^([Ss][Tt][Rr][Ii][Cc][Tt]|[Ll][Aa][Xx]|[Nn][Oo][Nn][Ee])$' }], default: 'strict' },
          },
        },
        hashIds: { type: 'boolean', enum: [true], default: true, description: 'Session ids are always stored hashed (SR-18); only true is accepted.' },
      },
    },
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
        encryptionKey: secretRef('AES-256-GCM key for stored MFA secrets; required when any step stores secrets.', {
          secret: { type: ['string', 'null'], pattern: MFA_KEY_PATTERN, description: '32 bytes as 64 hex characters, base64 or base64url.' },
          previous: { type: 'array', items: { type: 'string', pattern: MFA_KEY_PATTERN }, description: 'Earlier keys, so rows written under them still decrypt after a rotation.' },
        }),
        totp: {
          type: 'object',
          default: {},
          properties: {
            issuer: { type: 'string', minLength: 1, default: 'SpinaJS', description: 'Shown by authenticator apps; set your app name.' },
            algorithm: { type: 'string', enum: ['SHA1', 'SHA256', 'SHA512'], default: 'SHA1', description: 'SHA1 is what authenticator apps support.' },
            digits: { type: 'integer', minimum: 6, maximum: 10, default: 6 },
            period: { type: 'integer', minimum: 1, maximum: 300, default: 30, description: 'Seconds. A longer period lets one stolen code cover too much time (SR-15).' },
            window: { type: 'integer', minimum: 0, maximum: 10, default: 1, description: 'Time steps accepted on each side of the current one.' },
            recoveryCodes: { type: 'integer', minimum: 0, maximum: 100, default: 10, description: 'Issued at confirmation; every confirmation and regeneration hashes the whole set.' },
          },
        },
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
      propertyNames: { enum: ['service', 'login', 'mfa', 'reset', 'reauth', 'resetAfterSeconds', 'global', 'maxRows'] },
      properties: {
        service: { type: 'string', minLength: 1 },
        login: flow({ free: 5, baseDelayMs: 1000, maxDelayMs: 60000 }, { free: 20, baseDelayMs: 1000, maxDelayMs: 300000 }),
        mfa: flow({ free: 3, baseDelayMs: 1000, maxDelayMs: 300000 }, { free: 20, baseDelayMs: 1000, maxDelayMs: 300000 }),
        reset: flow({ free: 1, baseDelayMs: 60000, maxDelayMs: 3600000 }, { free: 5, baseDelayMs: 10000, maxDelayMs: 900000 }),
        reauth: flow({ free: 3, baseDelayMs: 1000, maxDelayMs: 300000 }),
        resetAfterSeconds: { type: 'integer', minimum: 1, default: 86400, description: 'A key with no counted attempt for this long starts from zero.' },
        global: { ...backoff(), type: ['object', 'null'], default: null, description: 'Off (null) by default: one attacker could slow every login. Counted per flow: each flow keeps its own global row.' },
        maxRows: { type: 'integer', minimum: 4, maximum: 16000000, default: 1000000, description: 'Rows a MemoryAuthnThrottle keeps per flow (memory grows with 4 × maxRows).' },
      },
    },
    freshAuth: {
      type: 'object',
      default: {},
      properties: {
        maxAgeSeconds: { type: 'integer', minimum: 1, default: 300, description: 'A session authenticated this many seconds ago or less counts as fresh (A13).' },
      },
    },
    token: {
      type: 'object',
      default: {},
      properties: {
        prefix: { type: 'string', minLength: 1, default: 'spt_', description: 'Lets secret scanners recognise a leaked token.' },
        length: { type: 'integer', minimum: 32, default: 32, description: 'Random bytes; at least 256 bits (A14). With the prefix a token stays within 1024 characters (a boot check).' },
        generation: {
          type: 'object',
          properties: {
            service: { type: 'string', minLength: 1 },
          },
        },
        maxTtlDays: { type: 'integer', minimum: 1, default: 90 },
        defaultTtlDays: { type: 'integer', minimum: 1, default: 30 },
        agentMaxTtlMinutes: { type: 'integer', minimum: 1, default: 1440 },
        headerName: { type: 'string', minLength: 1, default: 'x-api-key' },
        lastUsedUpdateInterval: { type: 'number', minimum: 0, default: 60, description: 'Seconds.' },
      },
    },
    jwt: {
      type: 'object',
      default: {},
      properties: {
        issuers: {
          type: 'array',
          default: [],
          // Each issuer once. A repeated provider is a code check: uniqueItemProperties counts a missing provider as a value.
          uniqueItemProperties: ['issuer'],
          items: {
            type: 'object',
            propertyNames: { enum: JWT_ISSUER_MEMBERS },
            properties: {
              issuer: { type: 'string', minLength: 1 },
              audience: { type: 'string', minLength: 1 },
              jwksUri: { type: 'string', format: 'uri' },
              keys: { type: 'array', minItems: 1, items: PUBLIC_JWK },
              algorithms: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: JWT_ALGORITHMS } },
              clockSkewSeconds: { type: 'integer', minimum: 0, maximum: 60, default: 30 },
              subjectClaim: { type: 'string', minLength: 1, default: 'sub' },
              provider: { type: 'string', minLength: 1, maxLength: 128, description: "The IdentityLink provider; default 'jwt:<issuer>'." },
              linking: { type: 'object', propertyNames: { enum: ['jit'] }, properties: { jit: { type: 'boolean' } } },
            },
            required: ['issuer', 'audience', 'algorithms'],
            oneOf: [{ required: ['jwksUri'] }, { required: ['keys'] }],
          },
        },
      },
    },
    keys: {
      type: 'object',
      default: {},
      properties: {
        algorithms: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['EdDSA', 'ES256'] }, default: ['EdDSA', 'ES256'] },
        challenge: {
          type: 'object',
          default: {},
          properties: {
            ttlSeconds: { type: 'integer', minimum: 1, maximum: 3600, default: 120 },
            audience: { type: ['string', 'null'], minLength: 1, default: null, description: "What clients put in a challenge's signing input; default: assertion.audience. Challenges need one of them." },
          },
        },
        assertion: {
          type: 'object',
          default: {},
          properties: {
            typ: { type: 'string', minLength: 1, default: 'spinajs-client+jwt' },
            audience: { type: ['string', 'null'], minLength: 1, default: null, description: 'Required once a strategy that reads assertions is listed.' },
            maxLifetimeSeconds: { type: 'integer', minimum: 1, maximum: 300, default: 300 },
            skewSeconds: { type: 'integer', minimum: 0, maximum: 300, default: 30 },
          },
        },
        httpSignature: {
          type: 'object',
          default: {},
          properties: {
            maxAgeSeconds: { type: 'integer', minimum: 1, maximum: 300, default: 300 },
            skewSeconds: { type: 'integer', minimum: 0, maximum: 300, default: 30 },
            requiredComponents: { ...stringList, default: ['@method', '@target-uri', 'content-digest'] },
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
      },
    },
    audit: {
      type: 'object',
      default: {},
      propertyNames: { enum: ['sampleUse', 'hashIdentifiers', 'hashKey', 'sinkTimeoutMs'] },
      properties: {
        sampleUse: { type: 'number', minimum: 0, maximum: 1, default: 0.01 },
        // Not `type: 'boolean'`: coerceTypes would turn a null into false and write raw identifiers.
        hashIdentifiers: { enum: [true, false], default: true },
        hashKey: {
          ...secretRef('HMAC key of LogAuthnAuditSink for hashed identifiers and of DbAuthnThrottle for its row keys; null: a random key per process, which DbAuthnThrottle refuses outside development and test.'),
          propertyNames: { enum: ['secret'] },
          properties: { secret: { type: ['string', 'null'], minLength: 32 } },
        },
        sinkTimeoutMs: { type: 'integer', minimum: 1, maximum: 60000, default: 2000, description: 'How long one sink may take.' },
      },
    },
    http: {
      type: 'object',
      default: {},
      properties: {
        publicOrigin: {
          type: ['string', 'null'],
          pattern: ORIGIN_PATTERN,
          description: "The origin clients put in an HTTP message signature's @target-uri (scheme://host[:port]); never taken from Host. Unset: signed requests get no principal.",
        },
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
          default: {},
          properties: {
            // Not `type: 'boolean'`: coerceTypes would turn a null into false and switch the guard off.
            enabled: { enum: [true, false], default: true },
            allowedOrigins: { type: 'array', default: [], items: { type: 'string', pattern: ORIGIN_PATTERN }, description: 'Besides the same origin, which is always allowed.' },
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
  },
};
