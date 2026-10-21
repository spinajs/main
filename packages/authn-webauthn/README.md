# `@spinajs/authn-webauthn`

WebAuthn for SpinaJS, on `@simplewebauthn/server`: passkey login (`PasskeyStrategy`), a WebAuthn second factor (`WebAuthnMfaStep`) and passkey management (`WebAuthnPasskeyService`).

## Turning passkeys on

1. `{ name: 'passkey', service: 'PasskeyStrategy' }` in the app's `authn.strategies`, and for the second factor `{ name: 'webauthn', service: 'WebAuthnMfaStep' }` in `authn.mfa.steps`;
2. `authn.webauthn.rpId`, `rpName` and `origins` (with no origin listed every ceremony fails);
3. `import '@spinajs/authn-webauthn/db';` once: it registers the ORM stores and the `AuthnWebauthn_2026_10_21_00_00_00` migration, and loads `@spinajs/authn-orm`.

`@spinajs/authn-http` serves the routes. Full documentation: `docs/authn-webauthn/`.
