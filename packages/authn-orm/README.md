# `@spinajs/authn-orm`

ORM stores and migrations for SpinaJS authentication (design §22.12, §22.13, §22.16,
§22.18).

## Migrations

Importing the package registers them on the `default` connection:

- `AuthnInitial_2026_10_02_00_00_00` creates `authn_identity`, `authn_throttle`,
  `authn_audit`, `authn_secret`, `authn_mfa`, `authn_recovery_code` and `authn_nonce`.
- `AuthnFromUserMetadata_2026_10_02_00_01_00` upgrades 2.x data out of
  `users_metadata`:
  - TOTP secrets are encrypted into `authn_mfa`.
  - Pending resets and invites are carried into `authn_secret` as SHA-256 hashes, with
    their 2.x expiry.
  - Every `2fa:`, `user:2fa:`, `user:login:`, `user:pwd_reset:` and `user:pwd:reset`
    key is deleted.

  When any user has a 2fa secret, the upgrade needs `authn.mfa.encryptionKey.secret`.
  `down()` decrypts the TOTP secrets back and deletes the carried reset and invite rows.
  It names the affected users, who then have to request a new link.

## Services

Each one is registered under its class name, so configuration can name it:

| Contract | Class | Config |
|---|---|---|
| `AuthnThrottle` | `DbAuthnThrottle` | `authn.throttle.service: 'DbAuthnThrottle'` |
| `SecretStore` | `DbSecretStore` | — |
| `IdentityLinkStore` | `DbIdentityLinkStore` | — |
| `AuthnEventSink` | `DbAuthnAuditSink` | listed in `authn.audit.sinks` |
| — | `DbNonceStore` (`NonceStore`, `MemoryNonceStore`) | — |
| — | `DbMfaStore` | for MFA steps (authn-totp) |

The MFA cipher (`mfaKeyFrom`, `encryptMfaSecret`, `decryptMfaSecret`) uses AES-256-GCM.
The format is `v1.<iv>.<tag>.<ct>`, and the additional authenticated data is
`<identity>|<step>`.

Every store resolves the Orm's `default` connection on first use. Tests pass a driver
instead.

## Rules the stores keep

- **Time comes from Node.** "Now" is `ctx.now`, or `Date` at call time; SQL `now()` is
  never used. Every claim, expiry or compare-and-set is decided in SQL against bound
  values. Datetime columns hold UTC wall-clock text.
- **Secrets are never stored in clear:**
  - single-use secrets and recovery codes are kept as SHA-256 only;
  - TOTP secrets are kept as cipher text only;
  - throttle keys are kept as an HMAC under `authn.audit.hashKey.secret`.
- **A login throttles, it never locks.** Attempts are counted before verification, one
  compare-and-set per key, so a burst gets exactly `free` verifications (A05, A06).

## Supported drivers and known gaps

- sqlite and postgres are tested against a real database. MySQL and MSSQL are checked only
  as compiled SQL.
- **postgres:** node-postgres reads `timestamp` as local time. A value that falls in the
  local spring DST gap therefore reads back one hour late. This needs a fix in
  orm-postgres; no store depends on such a read for a decision.
- **MySQL and MSSQL:**
  - `datetime` precision is lower, so the throttle's undo may miss, which errs towards
    more throttling. A sub-second `baseDelayMs` is not supported there.
  - Default collations ignore case, so the stores also check identity, purpose, provider
    and subject for exact equality in Node.
- **Races:** two parallel `issue` calls, or two `replaceRecoveryCodes` calls, for the same
  identity and purpose can leave two live rows. This is because the stores use no
  transactions, since the sqlite driver shares one handle.
