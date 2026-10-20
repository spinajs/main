# `@spinajs/authn-local`

Login and password authentication for SpinaJS. It ships the `local` login strategy, the argon2id hasher with an optional pepper, the password policy, and `LocalPasswordService`, which runs change, set, reset, invite and expiry. It also ships two CLI commands.

It does **not** store users, password hashes or single-use secrets, and it does not issue sessions or decide MFA. It reads and writes through the `@spinajs/authn` contracts, which other packages implement: [`@spinajs/users`](../users/README.md) holds identities and hashes, [`@spinajs/authn-orm`](../authn-orm/README.md) holds reset and invite secrets, and the authn core runs throttling, MFA and sessions. It serves no HTTP routes; [`@spinajs/authn-http`](../authn-http/README.md) does.

## Install

```sh
npm install @spinajs/authn-local @spinajs/authn
```

A working login also needs an `IdentityStore` and a `PasswordCredentialStore` (`@spinajs/users`), a `SecretStore` for reset and invite (`@spinajs/authn-orm`), and a `SessionIssuer` (`@spinajs/authn-session`).

## Features

| Feature | What it does |
| --- | --- |
| [Password login](01-password-login.md) | `LocalPasswordStrategy`: the `local` strategy for `password` credentials, with equal timing for unknown accounts and a rehash on login |
| [Password hashing](02-password-hashing.md) | `PasswordHasher` and `Argon2PasswordHasher`: argon2id at library defaults, optional HMAC pepper with rotation, a concurrency cap |
| [Password policy](03-password-policy.md) | `LocalPasswordPolicy`: length bounds, a JSON schema rule, the public policy, and the password generator |
| [Password blocklist](04-password-blocklist.md) | `PasswordBlocklist`: a named hook that refuses known-bad passwords when one is set |
| [Change and set](05-change-and-set.md) | `PasswordService.change()` with the old password, and `set()` without it |
| [Reset and invite](06-reset-and-invite.md) | `requestReset()`, `redeemReset()` and `invite()`: single-use secrets mailed at once, the same answer for every account |
| [Password mailer](07-password-mailer.md) | `PasswordMailer`: the hook that sends reset and invite mails |
| [Password expiry](08-password-expiry.md) | `PasswordService.expire()`, the `!expired` marker, and `PasswordExpirationJob` |
| [Password age source](09-password-age-source.md) | `PasswordAgeSource`: the hook that tells the expiry job which passwords are old |
| [CLI commands](10-cli-commands.md) | `authn:password` and `authn:password-expire` |
| [Password service](11-password-service.md) | `LocalPasswordService`: its collaborators, the test seam, and how to replace or extend it |
| [Audit events](12-audit-events.md) | The `AuthnEvent`s the password flows publish, with their reasons |

## Quick start

List the strategy in your app config. Config files concatenate arrays, so the package ships no `authn.strategies` entry:

```ts
// config/authn.ts in your app
export default {
  authn: {
    strategies: [{ name: 'local', service: 'LocalPasswordStrategy' }],
    local: {
      reset: { url: 'https://app.acme.com/reset-password' },
    },
  },
};
```

Then authenticate a login and password through the authn core:

```ts sample
import { AuthnService } from '@spinajs/authn';
import { DI } from '@spinajs/di';
import '@spinajs/authn-local';

/** Logs a user in from a back-office tool; a web app goes through authn-http's POST /auth/login instead. */
export async function logIn(login: string, password: string, ip: string): Promise<string> {
  const authn = await DI.resolve(AuthnService);
  const result = await authn.authenticate({ kind: 'password', login, password }, { now: new Date(), ip, purpose: 'login' });

  switch (result.status) {
    case 'success':
      return `logged in as ${result.identity.id}`;
    case 'mfa_required':
      return `second step needed: ${result.steps.join(', ')}`;
    default:
      // The reason is for audit; show the user one message for every failure.
      return 'wrong login or password';
  }
}
```

Importing `@spinajs/authn-local` registers `LocalPasswordStrategy`, `Argon2PasswordHasher`, `LocalPasswordPolicy`, `LocalPasswordService` and `PasswordExpirationJob`. Its config file adds the `authn.local` defaults and the CLI command directory.

## Configuration

Every key lives under `authn.local` and is validated by the `@spinajs/authn` config schema. Each feature page lists its keys:

| Keys | Page |
| --- | --- |
| `authn.local.hasher.*`, `authn.local.pepper.*` | [Password hashing](02-password-hashing.md#configuration) |
| `authn.local.policy.*`, `authn.local.generator.*` | [Password policy](03-password-policy.md#configuration) |
| `authn.local.reset.*`, `authn.local.invite.*` | [Reset and invite](06-reset-and-invite.md#configuration) |
| `authn.local.expiration.*` | [Password expiry](08-password-expiry.md#configuration) |

Throttling (`authn.throttle.login`, `reset`, `reauth`), MFA (`authn.mfa.*`) and sessions are configured in the [authn core](../authn/README.md).

## Related packages

- [`@spinajs/authn`](../authn/README.md): the contracts this package implements (`AuthenticationStrategy`, `PasswordService`) and the core that runs the login, throttle, MFA and audit.
- [`@spinajs/users`](../users/README.md): the `IdentityStore`, `PasswordCredentialStore` and `PasswordAgeSource` this package reads, and the default `PasswordMailer` registration ([Identity and password stores](../users/07-identity-and-password-stores.md)).
- [`@spinajs/authn-orm`](../authn-orm/README.md): `DbSecretStore` keeps the reset and invite secrets ([Single-use secrets](../authn-orm/02-secret-store.md)), and `DbAuthnThrottle` counts the attempts.
- [`@spinajs/authn-http`](../authn-http/README.md): the login, password policy, reset and change routes that call this package.
- [`@spinajs/authn-totp`](../authn-totp/README.md): the TOTP step a password login hands over to when MFA is required.
- [`@spinajs/email`](../email/08-password-mailer.md): `EmailPasswordMailer`, the default `PasswordMailer`.
- [Authentication internals](../authn/01-authentication-flow.md): where the password login sits among the tables and the other credential types.
