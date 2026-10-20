/** The authn.session fragment of the authn configuration; `expiration.maxLifetime` is in the authn schema. */
export const AUTHN_SESSION_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authn-session.configuration.schema.json',
  $configurationModule: 'authn.session',
  description: 'Session configuration (authn.session)',
  type: 'object',
  properties: {
    service: { type: 'string', minLength: 1 },
    expiration: {
      type: 'object',
      default: {},
      description: 'Minutes.',
      properties: {
        service: { type: 'string', minLength: 1 },
        ttl: { type: 'integer', minimum: 1, default: 30 },
      },
    },
    pendingTtlSeconds: { type: 'integer', minimum: 1, default: 300, description: 'Pre-MFA session (D25).' },
    cookie: {
      type: 'object',
      default: {},
      description: "'auto': on unless the env is development or test.",
      properties: {
        name: { type: 'string', minLength: 1, default: 'ssid' },
        // No `type`, so nothing is coerced: with coerceTypes a null would become false. String booleans (env values) are kept as given.
        hostPrefix: { enum: [true, false, 'auto', 'true', 'false'], default: 'auto' },
        secure: { enum: [true, false, 'auto', 'true', 'false'], default: 'auto' },
        // What the cookie writers (http and express) accept: booleans and any letter case.
        sameSite: { anyOf: [{ enum: [true, false] }, { type: 'string', pattern: '^([Ss][Tt][Rr][Ii][Cc][Tt]|[Ll][Aa][Xx]|[Nn][Oo][Nn][Ee])$' }], default: 'strict' },
      },
    },
    hashIds: { type: 'boolean', enum: [true], default: true, description: 'Session ids are always stored hashed (SR-18); only true is accepted.' },
  },
};
