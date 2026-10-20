# `@spinajs/authn-orm`

ORM stores and migrations for SpinaJS authentication (design §22.12, §22.13, §22.16,
§22.18).

## Migrations

Importing the package registers `AuthnInitial_2026_10_02_00_00_00` on the `default` connection. It
creates `authn_identity`, `authn_throttle`, `authn_audit`, `authn_secret`, `authn_mfa`,
`authn_recovery_code` and `authn_nonce`. Nothing is carried over from 2.x `users_metadata`: 2.x TOTP
enrolments, pending resets and invites do not survive the upgrade.

## Services

Each one is registered under its class name, so configuration can name it:

| Contract | Class | Config |
|---|---|---|
| `AuthnThrottle` | `DbAuthnThrottle` | used when `authn.throttle.service` is unset (or named) |
| `SecretStore` | `DbSecretStore` | — |
| `IdentityLinkStore` | `DbIdentityLinkStore` | — |
| `AuthnEventSink` | `DbAuthnAuditSink` | gets every event |
| — | `DbNonceStore` (`NonceStore`, `MemoryNonceStore`) | — |
| — | `DbMfaStore` | for MFA steps (authn-totp) |

Once this package is imported, the core uses `DbAuthnThrottle` when `authn.throttle.service` is unset:
it takes the only registered throttle besides `MemoryAuthnThrottle`. An app that wants the memory
throttle names it. The package ships no config file: config files load whether or not their package
is imported, so a shipped service name would break an app that has this package installed but unused
(authn-totp depends on it). `DbAuthnAuditSink` gets every event once registered.

The MFA cipher (`mfaKeyFrom`, `encryptMfaSecret`, `decryptMfaSecret`) uses AES-256-GCM.
The format is `v1.<iv>.<tag>.<ct>`, and the additional authenticated data is
`<identity>|<step>`. Callers must build the identity from `users.Uuid` exactly as it is
stored (`user:<Uuid>`), or the secret will not decrypt. Recovery codes are stored as
unsalted SHA-256, so steps must generate codes of at least 80 bits.

Every store reads and writes through the package's models (`AuthnIdentity`, `AuthnSecret`,
`AuthnNonce`, `AuthnMfa`, `AuthnRecoveryCode`, `AuthnThrottle`, `AuthnAudit`), which name the
table and the `default` connection. The stores take no driver: a store awaits `ormReady()` before
its first statement, and a test boots an Orm whose `default` connection is the database under test.

## Rules the stores keep

- **Time comes from Node.** "Now" is `ctx.now`, or `Date` at call time; SQL `now()` is
  never used. Every claim, expiry or compare-and-set is decided in SQL against bound
  values. Datetimes are written as UTC (ISO-8601 text on SQLite).
- **Secrets are never stored in clear:**
  - single-use secrets and recovery codes are kept as SHA-256 only;
  - TOTP secrets are kept as cipher text only;
  - throttle keys are kept as an HMAC under `authn.audit.hashKey.secret`. Without that
    secret the HMAC key is a public constant, so anyone who reads `authn_throttle` can
    test guessed logins and IPs against it. The store warns once at start.
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
  - Default collations ignore case. Every read therefore also checks identity, step,
    purpose, provider and subject for exact equality in Node. Writes keyed by identity
    still rely on the collation, so on these drivers the identity columns need a binary
    collation.
- **Races:** two parallel `issue` calls, or two `replaceRecoveryCodes` calls, for the same
  identity and purpose can leave two live rows. This is because the stores use no
  transactions, since the sqlite driver shares one handle.

## Throttle store

`DbAuthnThrottle` is a `StoreAuthnThrottle` (`@spinajs/authn`) over `DbThrottleStore`, a util `ThrottleStore` on
`authn_throttle`. The flow rules, keys and config are in `packages/authn/src/throttle/README.md`. `DbThrottleStore`
is exported for reuse and tests; `DbAuthnThrottle.createStore(options)` is the protected seam that builds it (override it to wrap or replace the store).
Writes are compare-and-set statements without a transaction (the sqlite driver shares one handle), so a lost race
only throttles more.
