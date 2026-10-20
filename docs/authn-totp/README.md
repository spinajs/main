# `@spinajs/authn-totp`

TOTP (RFC 6238) as the second factor of `@spinajs/authn`. It ships the `TotpMfaStep` that login asks for, the owner-side `TotpService` (enrol, confirm, disable, recovery codes, admin reset), encrypted secret storage over `@spinajs/authn-orm`, single-use recovery codes and two CLI commands.

It does **not** decide when MFA is required: the `MfaPolicy` of `@spinajs/authn` does. It does **not** mount HTTP routes: `@spinajs/authn-http` exposes `TotpService` (as the `MfaEnrolmentService`) and `AuthnService.completeMfa` over HTTP. It does **not** render a QR code for the enrolment routes: the client renders the `provisioning` URI it gets back.

TOTP is off until the app turns it on: see [Turning TOTP on](01-setup.md).

## Install

```sh
npm install @spinajs/authn-totp @spinajs/authn @spinajs/authn-orm
```

`DbMfaSecretStore` needs an ORM driver for the `default` connection, for example `@spinajs/orm-sqlite` or `@spinajs/orm-postgres`.

## Entry points

| Import | What it loads |
| --- | --- |
| `@spinajs/authn-totp` | Everything below except `DbMfaSecretStore`. Takes from `@spinajs/authn-orm` only the cipher (`@spinajs/authn-orm/cipher`) and `identityKey` (`@spinajs/authn-orm/identity`), two side-effect-free subpaths, so it registers no migration, DB store or DB default. |
| `@spinajs/authn-totp/db` | `DbMfaSecretStore`, registered as the `MfaSecretStore`. Loads `@spinajs/authn-orm` with its migration and DB stores. |
| `@spinajs/authn-totp/service` | `TotpService`, its result types and `TotpMfaStep`. |

## Features

| Feature | What it does |
| --- | --- |
| [Turning TOTP on](01-setup.md) | The `authn.mfa.steps` entry, the encryption key, the `/db` import and every `authn.mfa.totp` key |
| [Enrolment](02-enrolment.md) | `TotpService.begin` and `confirm`: a new secret, the `otpauth://` URI, confirmation with a first code, forced enrolment at first login |
| [The TOTP step at login](03-login-verification.md) | `TotpMfaStep.verify` inside `AuthnService.completeMfa`: pending session, code check, replay and drift protection, session upgrade to `aal2` |
| [Recovery codes](04-recovery-codes.md) | Ten single-use 80-bit codes at confirmation, login with a recovery code, regeneration |
| [Disable and admin reset](05-disable-and-reset.md) | `TotpService.disable` with fresh auth and a code; `adminReset` that never returns a secret |
| [Secret store](06-secret-store.md) | The `MfaSecretStore` extension point: `DbMfaSecretStore`, `MemoryMfaSecretStore` and custom stores |
| [Encryption keys](07-encryption-keys.md) | `MfaKeyRing` and `mfaKeyRingFrom`: AES-256-GCM secrets, key ids, key rotation |
| [CLI and QR codes](08-cli-and-qr.md) | `authn:mfa-reset`, `authn:mfa-qr` and `buildOtpAuthUrl` |
| [Wiring and testing](09-wiring-and-testing.md) | How `TotpMfaStep` and `TotpService` find their dependencies, and how to pass them yourself |

## Quick start

1. List the step and set the key in your app config:

   ```ts
   const config = {
     authn: {
       mfa: {
         steps: [{ name: 'totp', service: 'TotpMfaStep' }],
         encryptionKey: { secret: process.env.MFA_KEY }, // 32 bytes as 64 hex characters, base64 or base64url
         totp: { issuer: 'Acme Portal' },
       },
     },
   };
   export default config;
   ```

2. Import the DB store once, and start an enrolment for the signed-in user:

```ts sample
import '@spinajs/authn-totp/db';
import { TotpService } from '@spinajs/authn-totp';
import type { SessionHandle } from '@spinajs/authn/contracts';
import { DI } from '@spinajs/di';

/** The otpauth:// URI the client turns into a QR code, or why the enrolment cannot start. */
export async function startTotpEnrolment(session: SessionHandle, ip: string): Promise<string> {
  const totp = await DI.resolve(TotpService);
  const result = await totp.begin(session, { now: new Date(), purpose: 'reauth', ip });
  if (!result.ok) {
    throw new Error(`TOTP enrolment refused: ${result.code}`);
  }
  return result.provisioning;
}
```

With `@spinajs/authn-http` loaded, the same flow runs over `POST user/mfa` and `POST user/mfa/confirm`; see [Enrolment](02-enrolment.md#http-routes).

## Migration from 2.x

- The 2.x `rbac:user-enable-2fa` command and the `EnableUser2Fa` export are gone: they handed a TOTP secret to the operator. Use `authn:mfa-reset <login>` and let the user enrol again; see [CLI and QR codes](08-cli-and-qr.md).
- The QR command is `authn:mfa-qr`; `rbac:2fa-qr` is an alias of it. `buildOtpAuthUrl` keeps its name.
- 2.x `rbac.twoFactorAuth.*` settings become `authn.mfa.*`. The package ships no `rbac.twoFactorAuth.*` key. See [the migration guide](../authz/migration-guide.md).

## Related packages

- [`@spinajs/authn`](../authn/README.md): the `MfaStep` and `MfaPolicy` contracts, `AuthnService.completeMfa`, fresh auth, the `mfa` throttle and the audit sinks this package uses.
- [`@spinajs/authn-orm`](../authn-orm/README.md): `DbMfaStore` and the `authn_mfa` and `authn_recovery_code` tables behind `DbMfaSecretStore`, and the MFA cipher; see its [MFA store](../authn-orm/05-mfa-store.md).
- [`@spinajs/authn-http`](../authn-http/README.md): the `user/mfa*` enrolment routes and the `auth/mfa/verify` and `auth/mfa/recovery` login routes.
- [`@spinajs/authn-local`](../authn-local/README.md): the password login that leaves a pending session when TOTP is required.
- [`@spinajs/authn-session`](../authn-session/README.md): issues the pending session and elevates it to `aal2`.
