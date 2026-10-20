const stringList = { type: 'array', items: { type: 'string', minLength: 1 } };

/** The authn.keys fragment of the authn configuration; `assertion.typ` is in the authn schema. */
export const AUTHN_KEYS_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authn-keys.configuration.schema.json',
  $configurationModule: 'authn.keys',
  description: 'Client key configuration (authn.keys)',
  type: 'object',
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
};
