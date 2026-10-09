# `@spinajs/authn-totp`

TOTP multi-factor authentication for SpinaJS.

## Turning TOTP on

The package lists no MFA step in its config: arrays concatenate across config
files, so a listed step could not be turned off. An app enables TOTP with:

1. `{ name: 'totp', service: 'TotpMfaStep' }` in its own `authn.mfa.steps`;
2. `authn.mfa.encryptionKey.secret`: 32 random bytes as 64 hex characters, or
   as base64 / base64url (44 or 43 characters). On rotation, move the old key
   to `authn.mfa.encryptionKey.previous` so stored secrets still decrypt;
3. `import '@spinajs/authn-totp/db';` once in the app. This registers
   `DbMfaSecretStore` as the `MfaSecretStore`. It keeps secrets and recovery
   codes in authn-orm's `authn_mfa` and `authn_recovery_code` tables through
   authn-orm's `DbMfaStore`.

The import loads `@spinajs/authn-orm`, and with it authn-orm's migrations and
DB stores. On an Orm whose `default` connection runs migrations at startup,
the authn-orm data migration moves 2.x TOTP secrets into `authn_mfa`. The
root entry of this package loads none of this; it uses only authn-orm's cipher,
so rows the migration wrote decrypt under the same key. Without step 3, or
another registered `MfaSecretStore`, the step fails with an error naming
`MfaSecretStore`. Tests register `MemoryMfaSecretStore` as `MfaSecretStore`.

**Warning.** The same data migration deletes the 2.x `2fa:*`, `user:2fa:*`,
`user:login:*` and `user:pwd_reset:*` keys from `users_metadata`. Their 2.x reset
links stop working, and the 2.x failed-login count and lock go with
`user:login:*`.

The package ships no 2.x `rbac.twoFactorAuth` keys: with
`authn.config.rejectLegacyKeys` on they would fail every boot.

`authn:mfa-reset <login>` removes an account's enrolment and recovery codes and
prints no secret.
