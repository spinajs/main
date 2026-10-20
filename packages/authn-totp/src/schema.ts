/** The authn.mfa.totp fragment of the authn configuration. */
export const AUTHN_TOTP_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authn-totp.configuration.schema.json',
  $configurationModule: 'authn.mfa.totp',
  description: 'TOTP step configuration (authn.mfa.totp)',
  type: 'object',
  properties: {
    issuer: { type: 'string', minLength: 1, default: 'SpinaJS', description: 'Shown by authenticator apps; set your app name.' },
    algorithm: { type: 'string', enum: ['SHA1', 'SHA256', 'SHA512'], default: 'SHA1', description: 'SHA1 is what authenticator apps support.' },
    digits: { type: 'integer', minimum: 6, maximum: 10, default: 6 },
    period: { type: 'integer', minimum: 1, maximum: 300, default: 30, description: 'Seconds. A longer period lets one stolen code cover too much time (SR-15).' },
    window: { type: 'integer', minimum: 0, maximum: 10, default: 1, description: 'Time steps accepted on each side of the current one.' },
    recoveryCodes: { type: 'integer', minimum: 0, maximum: 100, default: 10, description: 'Issued at confirmation; every confirmation and regeneration hashes the whole set.' },
  },
};
