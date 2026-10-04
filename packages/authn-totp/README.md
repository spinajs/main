# `@spinajs/authn-totp`

TOTP multi-factor authentication for SpinaJS.

## Turning TOTP on

The package lists no MFA step in its config: arrays concatenate across config
files, so a listed step could not be turned off. An app enables TOTP with:

1. `{ name: 'totp', service: 'TotpMfaStep' }` in its own `authn.mfa.steps`;
2. `authn.mfa.encryptionKey.secret`: 32 random bytes as 64 hex characters, or
   as base64 / base64url (44 or 43 characters). On rotation, move the old key
   to `authn.mfa.encryptionKey.previous` so stored secrets still decrypt;
3. a registered `MfaSecretStore`: authn-orm's `DbMfaStore` in apps,
   `MemoryMfaSecretStore` in tests.

`authn:mfa-reset <login>` removes an account's enrolment and recovery codes and
prints no secret.
