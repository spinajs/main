const authnWebauthn = {
  authn: {
    /**
     * Off until the app lists `{ name: 'passkey', service: 'PasskeyStrategy' }` in `authn.strategies` (passkey login)
     * or `{ name: 'webauthn', service: 'WebAuthnMfaStep' }` in `authn.mfa.steps` (second factor), and imports
     * `@spinajs/authn-webauthn/db`. With no origin listed every ceremony fails, so the app sets its own.
     */
    webauthn: {
      rpId: 'localhost',
      rpName: 'SpinaJS',
      origins: [] as string[],
      userVerification: 'preferred',
      challengeTtlSeconds: 300,
      recoveryCodes: 10,
    },
  },
};

export default authnWebauthn;
