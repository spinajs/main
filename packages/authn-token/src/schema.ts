// Asymmetric JWS algorithms only: never 'none', never HMAC (design §22.9).
const JWT_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

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

/** The authn.token fragment of the authn configuration; `prefix` and `headerName` are in the authn schema. */
export const AUTHN_TOKEN_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authn-token.configuration.schema.json',
  $configurationModule: 'authn.token',
  description: 'API token configuration (authn.token)',
  type: 'object',
  properties: {
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
    lastUsedUpdateInterval: { type: 'number', minimum: 0, default: 60, description: 'Seconds.' },
  },
};

/** The authn.jwt fragment of the authn configuration. */
export const AUTHN_JWT_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authn-token.jwt.configuration.schema.json',
  $configurationModule: 'authn.jwt',
  description: 'JWT bearer issuers (authn.jwt)',
  type: 'object',
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
};
