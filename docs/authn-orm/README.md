# `@spinajs/authn-orm`

SQL storage for `@spinajs/authn`: the login throttle, single-use secrets, external identity links, nonces, MFA enrolments with recovery codes, and the audit trail. Every store reads and writes through an ORM model on the `default` connection. The package ships the migration that creates the seven `authn_*` tables.

It does **not** verify credentials, issue sessions or decide MFA policy: `@spinajs/authn` and the strategy packages do that and call these stores. It ships no config file; the `authn.*` keys it reads belong to the `@spinajs/authn` schema.

## Install

```sh
npm install @spinajs/authn-orm @spinajs/authn @spinajs/orm
```

Add one ORM driver, for example `@spinajs/orm-sqlite` or `@spinajs/orm-postgres`.

## Features

| Feature | What it does |
| --- | --- |
| [Database throttle](01-throttle.md) | `DbAuthnThrottle` and `DbThrottleStore`: per-key backoff in `authn_throttle`, shared by every app instance, keyed by an HMAC of the key |
| [Single-use secrets](02-secret-store.md) | `DbSecretStore`: reset, invite and key-challenge secrets in `authn_secret`, stored as SHA-256, redeemed once |
| [Identity links](03-identity-links.md) | `DbIdentityLinkStore`: external subjects (OIDC, JWT issuers) linked to identities in `authn_identity` |
| [Nonce store](04-nonce-store.md) | `DbNonceStore`, and the re-exported `NonceStore` and `MemoryNonceStore` of `@spinajs/authn`: values claimed exactly once until they expire, in `authn_nonce` |
| [MFA store](05-mfa-store.md) | `DbMfaStore`, `DbMfaEnrolments` and the MFA cipher: encrypted MFA secrets, replay-safe time steps and recovery codes in `authn_mfa` and `authn_recovery_code` |
| [Audit sink](06-audit-sink.md) | `DbAuthnAuditSink`: one `authn_audit` row per authentication event |
| [Models and schema](07-models-and-schema.md) | The seven models, their tables and columns, the migration, the `default` connection, identity keys, datetimes and driver support |

## Where the stores run in the authn flow

Each store implements a port of `@spinajs/authn` or of a strategy package. The steps refer to [How a login runs](../authn/01-authentication-flow.md).

| Store | Port it fills | Flow step that calls it | Consuming packages |
| --- | --- | --- | --- |
| `DbAuthnThrottle` | `AuthnThrottle` | Login step 2 (count or peek) and steps 6 and 7 (reset on success); `completeMfa` (`mfa` flow); `reauthenticate` (`reauth` flow) | [`@spinajs/authn`](../authn/README.md), [`@spinajs/authn-local`](../authn-local/README.md) (`reset`, `reauth`), [`@spinajs/authn-totp`](../authn-totp/README.md) (`mfa`), [`@spinajs/authn-keys`](../authn-keys/README.md) (login challenges) |
| `DbSecretStore` | `SecretStore` | Password reset and invite; key challenges, redeemed in login step 3 | [`@spinajs/authn-local`](../authn-local/README.md), [`@spinajs/authn-keys`](../authn-keys/README.md) |
| `DbIdentityLinkStore` | `IdentityLinkStore` | Login step 4, mapping an external subject to an identity; account linking | [`@spinajs/authn`](../authn/README.md), [`@spinajs/authn-oidc`](../authn-oidc/README.md), [`@spinajs/authn-token`](../authn-token/README.md) (JWT bearer subjects) |
| `DbNonceStore` | `NonceStore` | Login step 3 of an OIDC callback: the `state` is claimed once | [`@spinajs/authn-oidc`](../authn-oidc/README.md) |
| `DbMfaStore` | none (used by `DbMfaSecretStore`) | Login step 7 and `completeMfa`: TOTP codes and recovery codes; TOTP enrolment | [`@spinajs/authn-totp`](../authn-totp/README.md) |
| `DbMfaEnrolments` | `MfaEnrolments` | Login step 6: `DefaultMfaPolicy` looks for confirmed enrolments in unlisted steps | [`@spinajs/authn`](../authn/README.md) |
| `DbAuthnAuditSink` | `AuthnEventSink` | Every step that publishes an event | every authn package |

## Quick start

```ts sample
import { DbSecretStore } from '@spinajs/authn-orm';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/orm-sqlite';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      authn: {
        // 32+ characters; keys the throttle rows. Outside development and test the boot refuses it unset.
        audit: { hashKey: { secret: process.env.AUTHN_HASH_KEY ?? null } },
      },
      db: {
        DefaultConnection: 'main',
        Connections: [
          {
            Name: 'main',
            Driver: 'orm-driver-sqlite',
            Filename: './data/app.sqlite',
            Migration: { OnStartup: true },
          },
        ],
      },
    });
  }
}

/** Issues the raw secret a password-reset mail carries; only its SHA-256 is stored. */
export async function issueResetSecret(userUuid: string): Promise<string> {
  const secrets = await DI.resolve(DbSecretStore);
  return await secrets.issue({ type: 'user', id: userUuid }, 'reset', 3600);
}
```

Importing `@spinajs/authn-orm` registers the stores, the seven models and the migration `AuthnInitial_2026_10_02_00_00_00`. `db.DefaultConnection` creates the `default` connection the models and the migration use. With `Migration.OnStartup`, resolving `OrmMigrator` (`@spinajs/orm`) at boot creates the tables; resolving a store resolves only the `Orm`, which creates none. With `authn.throttle.service` unset, the authn core picks `DbAuthnThrottle`, the only registered throttle besides `MemoryAuthnThrottle`.

## Supported databases

- SQLite and PostgreSQL are tested against a real database.
- MySQL and MSSQL are checked only as compiled SQL. Their default collations ignore case and their `datetime` is coarser; see [Models and schema](07-models-and-schema.md#drivers-and-known-gaps).

## Related packages

- [`@spinajs/authn`](../authn/README.md): the contracts these stores implement (`AuthnThrottle`, `SecretStore`, `IdentityLinkStore`, `MfaEnrolments`, `AuthnEventSink`) and the `authn.*` config schema.
- [Authentication internals](../authn-orm/07-models-and-schema.md): where each table sits in the login flow.
- [`@spinajs/authn-local`](../authn-local/README.md): password reset and invite secrets, and the `reset` and `reauth` throttle flows.
- [`@spinajs/authn-oidc`](../authn-oidc/README.md): links external subjects through `authn_identity` and claims each OIDC `state` in `authn_nonce`.
- [`@spinajs/authn-totp`](../authn-totp/README.md): `DbMfaSecretStore` over `DbMfaStore`, and the MFA cipher.
- [`@spinajs/authn-keys`](../authn-keys/README.md): key challenges in `authn_secret`; its `jti` and signature nonce claims go through `DbNonceStore` into `authn_nonce`.
- [`@spinajs/authn-token`](../authn-token/README.md): JWT bearer subjects that the core maps through `authn_identity`.
- [`@spinajs/orm`](../orm/README.md): models, [connections](../orm/01-connections.md) and [migrations](../orm/10-migrations.md) the stores run on.
- [`@spinajs/util` throttle](../util/10-throttle.md): the `Throttle` and `ThrottleStore` mechanics `DbThrottleStore` implements.
