# Single-use secrets

`DbSecretStore` is the `SecretStore` of `@spinajs/authn`. It issues random secrets for password resets, invites, email confirmation and key challenges, and redeems each one once. Only the SHA-256 of a secret is stored.

## Where it runs in the authn flow

Callers resolve the `SecretStore` port of `@spinajs/authn`; this package registers `DbSecretStore` under it.

| Caller | Purpose | When it calls |
| --- | --- | --- |
| `LocalPasswordService` ([`@spinajs/authn-local`](../authn-local/README.md)) | `reset`, `invite` | `issue` right before the reset or invite mail goes out; `redeemReset` always runs two `redeem` calls, `reset` then `invite`, on a throwaway identity where none is due, so the timing does not tell a pending invite from a missing login. |
| `KeyRegistry` ([`@spinajs/authn-keys`](../authn-keys/README.md)) | `key-challenge:<rid>` | `issue` when a client requests a register or login challenge; `redeem` when the signed challenge comes back. |
| Key challenge strategy ([`@spinajs/authn-keys`](../authn-keys/README.md)) | `key-challenge:<rid>` | Login step 3 of [How a login runs](../authn/01-authentication-flow.md): `redeem` after the signature over the challenge verifies. |

## How it works

### Issue, `issue(identity, purpose, ttlSeconds)`

1. `identityKey(identity)` builds the `identity` column value, `<type>:<id>`. A type that is empty or contains `:`, or a key longer than 100 characters, throws `InvalidArgument`.
2. The store checks `purpose` (a non-empty string of at most 32 characters) and `ttlSeconds` (a finite number above 0). A bad value throws `InvalidArgument`.
3. It takes "now" from the Node clock, awaits `ormReady()`, and on every 64th `issue` or `redeem` call of the instance runs `purge()` first.
4. It makes the raw secret: 32 random bytes as base64url, 43 characters.
5. `AuthnSecret.destroy()` deletes the identity's rows of that purpose, so a new secret replaces the older ones.
6. `AuthnSecret.insert()` writes a row with a random UUID `id`, the hex SHA-256 of the raw secret, `expires_at` = now + `ttlSeconds`, and `used_at` `NULL`.
7. It resolves with the raw secret. Nothing stores it.

### Redeem, `redeem(identity, purpose, raw)`

1. The identity and purpose are checked as in issue; a bad one throws `InvalidArgument`. A `raw` that is not a non-empty string of at most 1024 characters resolves `false` with no query.
2. The store selects unused rows by `secret_hash` = SHA-256(`raw`), `identity` and `purpose`.
3. It keeps only a row whose `identity` and `purpose` equal the input exactly in Node. No row, or an `expires_at` already past, resolves `false`.
4. `AuthnSecret.update({ used_at: now })` runs where `id` matches, `used_at IS NULL` and `expires_at > now`. It resolves `true` only when that statement changed one row.

### Purge, `purge(now?)`

1. `purge(now = new Date())` selects up to 500 ids of rows that are used or expired, ordered by `id`.
2. It deletes those ids under the same condition and resolves with the number deleted.

## Configuration

`DbSecretStore` reads no key. Callers pass the lifetime; these keys of `@spinajs/authn-local` set it for its secrets:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.local.reset.ttlSeconds` | `number` | `3600` | integer ≥ 1 | `ttlSeconds` of a password-reset secret. |
| `authn.local.invite.ttlSeconds` | `number` | `900` | integer ≥ 1 | `ttlSeconds` of an invite secret. |

See [`@spinajs/authn` Config](../authn/13-configuration-and-boot-checks.md) for the rest of `authn.local.*`.

## Schema

### `authn_secret`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `varchar(36)`, primary key | Random UUID. |
| `identity` | `varchar(100)` | `<type>:<id>` of the owner. |
| `purpose` | `varchar(32)` | `reset`, `invite` or another caller-chosen name. |
| `secret_hash` | `varchar(64)`, unique index `authn_secret_hash` | Hex SHA-256 of the raw secret. |
| `expires_at` | `datetime` | The secret redeems only before this time. |
| `used_at` | `datetime`, nullable | Set by the one successful `redeem`. |
| `created_at` | `datetime` | Time of `issue`. |

Index `authn_secret_owner` covers `(identity, purpose)`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Secret store | `SecretStore`, per child container; also registered as `DbSecretStore` | `DbSecretStore` | `MemorySecretStore` (`@spinajs/authn-testing`) | Register your class under `SecretStore` after this package is imported: a single resolve takes the last registration. Subclass `DbSecretStore` to keep the storage. |

`DbSecretStore` has the public `issue`, `redeem` and `purge`. Its protected `liveInNode(expiresAt, nowMs)` is marked `@internal`: an early exit before the claim, which decides in SQL.

### Secret store: custom implementation

Subclass `DbSecretStore`, override `issue` or `redeem`, call `super`, and register the subclass under `SecretStore` with `@Injectable(SecretStore)`.

```ts sample
import { DbSecretStore } from '@spinajs/authn-orm';
import { SecretStore } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { Injectable, PerChildInstance } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';

const KNOWN_PURPOSES = new Set(['reset', 'invite', 'email-confirm']);

/** Refuses a purpose the app does not know, so a typo cannot issue a secret nobody redeems. */
@PerChildInstance()
@Injectable(SecretStore)
export class KnownPurposeSecretStore extends DbSecretStore {
  public override async issue(identity: IdentityRef, purpose: string, ttlSeconds: number): Promise<string> {
    if (!KNOWN_PURPOSES.has(purpose)) {
      throw new InvalidArgument(`unknown secret purpose "${purpose}"`);
    }
    return super.issue(identity, purpose, ttlSeconds);
  }
}
```

## Important behaviour

- The raw secret has 256 bits and is returned once. The table holds only its SHA-256, and the lookup is by that hash, so no stored value is compared with the input in Node.
- `redeem` is single use: of parallel calls with one secret, exactly one resolves `true`.
- `redeem` resolves `false` for a wrong, expired, redeemed or other-purpose secret, and for another identity's secret.
- `issue` deletes and then inserts without a transaction. Two parallel `issue` calls for one identity and purpose can both leave a live row.
- Time comes from the Node clock at call time; SQL `now()` is never used.
- Expired and used rows stay until a purge. The purge runs on every 64th `issue` or `redeem` of the instance and deletes at most 500 rows.
- On MySQL and MSSQL the default collations ignore case. `redeem` therefore checks identity and purpose for exact equality in Node, but the delete in `issue` still matches by the collation.
- Values are never truncated: a purpose of more than 32 characters (code points) or an identity key of more than 100 throws.

## Best practices

- Read the purpose names from one constant shared by the issuing and the redeeming code: `redeem` with another purpose resolves `false`.
- Call `purge()` in a loop from a maintenance job when secrets are issued rarely; each call deletes at most 500 rows.
- Pass `raw` to `redeem` exactly as `issue` returned it: the store hashes it as given, so trimmed or re-encoded input resolves `false`.

## Patterns and antipatterns

```ts
// Don't: the store keeps only the hash; this log line is the only copy of a usable secret
const raw = await secrets.issue(user, 'reset', 3600);
log.info(`issued reset secret ${raw}`);

// Do: hand the raw secret to the mail and nowhere else
const raw = await secrets.issue(user, 'reset', 3600);
await mailer.sendResetLink(user, raw);
```

## Examples

### Confirm a new email address

```ts sample
import { SecretStore } from '@spinajs/authn/contracts';
import { DI } from '@spinajs/di';

const PURPOSE = 'email-confirm';

/** The link in the confirmation mail carries the returned value. */
export async function startEmailConfirmation(userUuid: string): Promise<string> {
  const secrets = await DI.resolve(SecretStore);
  return await secrets.issue({ type: 'user', id: userUuid }, PURPOSE, 24 * 3600);
}

export async function confirmEmail(userUuid: string, rawFromLink: string): Promise<boolean> {
  const secrets = await DI.resolve(SecretStore);
  return await secrets.redeem({ type: 'user', id: userUuid }, PURPOSE, rawFromLink);
}
```

### Purge spent secrets from a nightly job

```ts sample
import { DbSecretStore } from '@spinajs/authn-orm';
import { DI } from '@spinajs/di';

export async function purgeSpentSecrets(): Promise<number> {
  const secrets = await DI.resolve(DbSecretStore);
  let removed = 0;
  for (let batch = await secrets.purge(); batch > 0; batch = await secrets.purge()) {
    removed += batch;
  }
  return removed;
}
```

## Related

- [`@spinajs/authn` Local password](../authn-local/README.md): reset and invite, the main callers of this store.
- [`@spinajs/authn-local`](../authn-local/README.md): `LocalPasswordService`, which issues and redeems reset and invite secrets.
- [`@spinajs/authn-keys`](../authn-keys/README.md): key challenges, issued and redeemed through `SecretStore`.
- [Authentication internals: store ports](../authn/02-contracts-and-packages.md): `SecretStore` among the other ports.
- [Models and schema](07-models-and-schema.md#authn_secret): the `AuthnSecret` model and the `default` connection.
