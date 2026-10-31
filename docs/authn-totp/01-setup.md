# Turning TOTP on

The package lists no MFA step in its own config, so TOTP stays off until the app turns it on.

## How it works

An app turns TOTP on in three steps:

1. List `{ name: 'totp', service: 'TotpMfaStep' }` in its own `authn.mfa.steps`. The `MfaPolicy` of `@spinajs/authn` finds the step among the registered `MfaStep` classes by that service name.
2. Set `authn.mfa.encryptionKey.secret`: 32 random bytes as 64 hex characters, or as base64 or base64url. The package ships no default for it. See [Encryption keys](07-encryption-keys.md).
3. `import '@spinajs/authn-totp/db';` once. It registers `DbMfaSecretStore` as the `MfaSecretStore`, over `DbMfaStore` of `@spinajs/authn-orm`. See [Secret store](06-secret-store.md).

What happens on first use:

1. Importing the root entry registers `TotpMfaStep` as an `MfaStep` and `TotpService` as the `MfaEnrolmentService` of `@spinajs/authn/contracts`. Nothing is read yet.
2. The first call on `TotpMfaStep` resolves its dependencies once and keeps them: the `MfaSecretStore`, the key ring built by `mfaKeyRingFrom(authn.mfa.encryptionKey)`, the options of `authn.mfa.totp` and the optional `IdentityStore`.
3. It fails with `InvalidOperation` when no `MfaSecretStore` is registered (the message names `@spinajs/authn-totp/db`), and with `InvalidOption` when `authn.mfa.encryptionKey.secret` is not set or a `authn.mfa.totp` value is out of range.

`@spinajs/authn` checks the key earlier: `TotpMfaStep` declares `storesSecrets: true`, so outside development and test a missing `authn.mfa.encryptionKey` fails boot; in development and test it only warns. See [`@spinajs/authn`](../authn/04-mfa-policy-and-steps.md).

## Configuration

`authn.mfa.totp` and `authn.mfa.encryptionKey` are part of the `@spinajs/authn` config schema. The package config file repeats the `authn.mfa.totp` defaults and adds its CLI folder to `system.dirs.cli`.

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.mfa.steps` | `{ name, service }[]` | `[]` | add `{ name: 'totp', service: 'TotpMfaStep' }` | Turns the TOTP step on. |
| `authn.mfa.encryptionKey.secret` | `string \| null` | unset | 32 bytes as 64 hex characters, base64 or base64url | The AES-256-GCM key that encrypts new TOTP secrets. |
| `authn.mfa.encryptionKey.previous` | `string[]` | unset | keys in the same formats | Earlier keys, kept so rows written under them still decrypt. |
| `authn.mfa.totp.issuer` | `string` | `'SpinaJS'` | non-empty | Issuer in the `otpauth://` URI, shown by authenticator apps. Set your app name. |
| `authn.mfa.totp.algorithm` | `string` | `'SHA1'` | `'SHA1'`, `'SHA256'`, `'SHA512'` | HMAC algorithm of the codes. |
| `authn.mfa.totp.digits` | `number` | `6` | integer 6 to 10 | Code length. |
| `authn.mfa.totp.period` | `number` | `30` | integer 1 to 300 | Seconds per time step. |
| `authn.mfa.totp.window` | `number` | `1` | integer 0 to 10 | Time steps accepted on each side of the current one (clock drift). |
| `authn.mfa.totp.recoveryCodes` | `number` | `10` | integer 0 to 100 | Recovery codes issued at confirmation and regeneration. `0` issues none. |
| `authn.freshAuth.maxAgeSeconds` | `number` | `300` | positive integer | How old a login may be for `begin`, `disable` and `regenerateRecoveryCodes`. Owned by `@spinajs/authn`. |
| `authn.mfa.policy.force` | `boolean` | `false` | | Makes enrolment part of the first login. Owned by `@spinajs/authn`; see [Enrolment](02-enrolment.md#forced-enrolment-at-first-login). |

```ts
const config = {
  authn: {
    mfa: {
      steps: [{ name: 'totp', service: 'TotpMfaStep' }],
      encryptionKey: {
        secret: process.env.MFA_KEY,
        previous: [process.env.MFA_KEY_2025],
      },
      totp: { issuer: 'Acme Portal', algorithm: 'SHA1', digits: 6, period: 30, window: 1, recoveryCodes: 10 },
    },
  },
};
export default config;
```

`algorithm`, `digits` and `period` go into the `otpauth://` URI. Changing them after users enrolled breaks their codes: the authenticator app keeps the values it scanned.

## Schema

The package ships no table and no migration. `DbMfaSecretStore` writes `authn_mfa` and `authn_recovery_code`, created by the migration of `@spinajs/authn-orm`. Columns: [MFA store](../authn-orm/05-mfa-store.md).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| TOTP step | `MfaStep` (one of `Array.ofType(MfaStep)`), singleton; picked by `authn.mfa.steps[].service` | `TotpMfaStep` | none shipped | Keep the class: `TotpService.enabled()` is true only when the listed steps include `TotpMfaStep` itself, not a subclass, so a subclass turns the `@spinajs/authn-http` enrolment routes off. Pass dependencies through its constructor; see [Wiring and testing](09-wiring-and-testing.md). |
| Owner service | `MfaEnrolmentService` (`@spinajs/authn/contracts`), singleton | `TotpService` | none shipped | `@spinajs/authn-http` injects the `MfaEnrolmentService` and serves its routes while `enabled(steps)` is true for the configured MFA policy's steps. |
| Secret store | `MfaSecretStore`; `DbMfaSecretStore` is `@PerChildInstance()` | none until `import '@spinajs/authn-totp/db'`, then `DbMfaSecretStore` | `MemoryMfaSecretStore` (not registered) | `DI.register(MyStore).as(MfaSecretStore)`; see [Secret store](06-secret-store.md). |

## Important behaviour

- `import '@spinajs/authn-totp/db'` loads all of `@spinajs/authn-orm`: its migration, `DbAuthnThrottle`, `DbAuthnAuditSink`, `DbMfaEnrolments` and its other stores register too. The root entry loads none of them.
- With `DbMfaEnrolments` registered, `DefaultMfaPolicy` refuses the password login of a user with a confirmed `totp` row once `totp` is no longer in `authn.mfa.steps`. Remove the enrolments before you remove the step. See [`@spinajs/authn`](../authn/04-mfa-policy-and-steps.md).
- The step reads its options, key ring and store on first use and keeps them for its lifetime. A config change at runtime, such as a new key, takes effect after a restart.
- A `authn.mfa.totp` value out of range fails on first use with `InvalidOption`, also when it never went through the schema (constructor options, `Configuration.set` at runtime).

## Best practices

- Set `authn.mfa.totp.issuer` to the name your users know: it goes into the `otpauth://` URI the authenticator app shows.
- Pass `authn.mfa.encryptionKey.secret` from an environment variable or a secret store, never from a committed config file.

## Patterns and antipatterns

```ts
// Don't: every app that loads a shared config file and sets no steps of its own gets TOTP
// (shared-config/authn.ts, loaded by several apps)
const shared = { authn: { mfa: { steps: [{ name: 'totp', service: 'TotpMfaStep' }] } } };

// Do: list the step in the config of the one app that uses it
const app = { authn: { mfa: { steps: [{ name: 'totp', service: 'TotpMfaStep' }], encryptionKey: { secret: process.env.MFA_KEY } } } };
```

## Related

- [`@spinajs/authn` MFA](../authn/04-mfa-policy-and-steps.md): `MfaPolicy`, `force`, `forceForRoles` and the boot checks.
- [Encryption keys](07-encryption-keys.md): key formats and rotation.
- [Secret store](06-secret-store.md): what the `/db` entry registers.
