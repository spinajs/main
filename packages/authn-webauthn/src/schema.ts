/** The authn.webauthn fragment of the authn configuration. */
export const AUTHN_WEBAUTHN_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authn-webauthn.configuration.schema.json',
  $configurationModule: 'authn.webauthn',
  description: 'WebAuthn relying party (authn.webauthn)',
  type: 'object',
  propertyNames: { enum: ['rpId', 'rpName', 'origins', 'userVerification', 'challengeTtlSeconds', 'recoveryCodes', 'challenges'] },
  properties: {
    rpId: { type: 'string', minLength: 1, maxLength: 253, default: 'localhost', description: 'The registrable domain the credentials are scoped to, e.g. example.com; changing it orphans every credential.' },
    rpName: { type: 'string', minLength: 1, default: 'SpinaJS', description: 'Shown by the authenticator.' },
    origins: { type: 'array', items: { type: 'string', pattern: '^https?://[^/\\s]+$' }, default: [], description: 'Exact origins (scheme, host, port) a ceremony may come from; none: every ceremony fails.' },
    userVerification: { type: 'string', enum: ['required', 'preferred', 'discouraged'], default: 'preferred', description: "Asked of the authenticator; only 'required' refuses an assertion without it. A passkey login with it is aal2, without it aal1." },
    challengeTtlSeconds: { type: 'integer', minimum: 30, maximum: 600, default: 300 },
    recoveryCodes: { type: 'integer', minimum: 0, maximum: 100, default: 10, description: 'Issued when the second factor is confirmed.' },
    challenges: {
      type: 'object',
      default: {},
      additionalProperties: false,
      properties: {
        maxRows: { type: 'integer', minimum: 1, maximum: 16000000, default: 100000, description: 'Challenges kept for anonymous passkey logins; past it POST /auth/passkeys/challenge answers 503.' },
      },
    },
  },
};
