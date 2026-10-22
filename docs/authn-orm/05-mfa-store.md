# MFA store

`DbMfaStore` keeps the MFA enrolments of identities in `authn_mfa` and their recovery codes in `authn_recovery_code`. It stores cipher text it is given, decides replay and single use in SQL, and never encrypts or decrypts. `authn-totp`'s `DbMfaSecretStore` and this package's `DbMfaEnrolments` and `DbMfaEnrolmentMarks` build on it.

## Where it runs in the authn flow

`DbMfaStore` fills no `@spinajs/authn` port itself. Three adapters put it into the flow:

| Adapter | Port | Caller | When it calls |
| --- | --- | --- | --- |
| `DbMfaSecretStore` ([`@spinajs/authn-totp`](../authn-totp/README.md), loaded by `import '@spinajs/authn-totp/db'`) | `MfaSecretStore` | `TotpMfaStep`, also on behalf of `TotpService` | `completeMfa`, on the pending session that login step 7 of [How a login runs](../authn/01-authentication-flow.md) issued: `get` and `acceptStep` verify a TOTP code; `redeemRecoveryCode` spends a normalised recovery code. Enrolment: `get`, `putPending`, `acceptStep`, `confirm` with the stored cipher text, `replaceRecoveryCodes`. Disabling and admin reset: `remove`, `removeRecoveryCodes`. |
| `DbMfaEnrolments` (this package) | `MfaEnrolments` | `DefaultMfaPolicy` and `authn:check-config` ([`@spinajs/authn`](../authn/04-mfa-policy-and-steps.md)) | Login step 6: when the identity is enrolled in no listed step, `stepsOf` reports confirmed steps that `authn.mfa.steps` does not list. |
| `DbMfaEnrolmentMarks` (this package) | `MfaEnrolmentMarks` | `EmailCodeMfaStep` ([`@spinajs/authn-local`](../authn-local/15-email-codes.md)) | `has` reads a confirmed row; `mark` calls `putPending` with a placeholder and confirms that placeholder, so exactly one caller marks; `unmark` calls `remove`. The row holds no secret: `secret_enc` is `mark` and `key_id` is `none`. |

`DbMfaSecretStore` maps its port onto `DbMfaStore` this way:

- Its `put` calls `putPending`, so a new enrolment never overwrites a confirmed one. `DbMfaStore` itself has no `put`.
- Its `confirm` without `expectedSecretEnc` reads the row and confirms only that cipher text, so a confirmed row answers `false`.
- Every other method calls the `DbMfaStore` method of the same name.

## How it works

Every method first builds the identity key with `identityKey(id)` (`<type>:<id>`, at most 100 characters) and checks the step name (1 to 32 characters). A bad value throws `InvalidArgument`. The store injects the `Orm`, so resolving it binds the models before any method runs.

### Enrol, `putPending()`

1. `putPending(id, step, secretEnc, keyId)` checks `secretEnc` (non-empty) and `keyId` (1 to 32 characters) and takes "now" from the Node clock.
2. It inserts an unconfirmed row: `confirmed_at` and `last_step` `NULL`, `secret_hash` the hex SHA-256 of `secretEnc`, `created_at` now, and resolves `true`.
3. On a duplicate `(identity, step)` (`UniqueViolation`) it updates the row to the same unconfirmed values where `confirmed_at IS NULL`, and resolves `true` when a row changed.
4. When no row changed and the row is confirmed, it resolves `false` and changes nothing. A row deleted in between sends it back to step 2, up to 8 times; then it throws `UnexpectedServerError`.

### Confirm, `confirm(id, step, at?, expectedSecretEnc?)`

1. Without `expectedSecretEnc`, it sets `confirmed_at` = `at` (default now) on the row and resolves `true` when the row exists.
2. With `expectedSecretEnc`, the update also requires `confirmed_at IS NULL` and `secret_hash` equal to the hex SHA-256 of it. Of parallel confirmations exactly one resolves `true`.
3. Comparing the hex hash keeps the match exact on every driver without casting the `text` column: SQL Server cannot compare `text` with `=`, and MySQL compares it case-blind by default.

### Accept a code, `acceptStep(id, step, timeStep)`

1. `timeStep` must be an integer from 0 to `Number.MAX_SAFE_INTEGER`; anything else throws `InvalidArgument`.
2. One `UPDATE` sets `last_step = timeStep` where `last_step` is `NULL` or lower.
3. It resolves `true` once per time step. A step at or below the last accepted one, or a missing enrolment, resolves `false`.

### Read and remove

1. `get(id, step)` resolves with an `MfaRecord` (`secretEnc`, `keyId`, `confirmedAt`, `lastStep`, `createdAt`), or `null`. It keeps only a row whose identity and step equal the input exactly.
2. `confirmedSteps(id)` resolves with the names of the identity's confirmed steps.
3. `confirmedStepNames()` resolves with each step name that has a confirmed row of any identity, once. Duplicates are removed in Node, so `totp` and `TOTP` stay apart on a case-blind collation.
4. `remove(id, step)` deletes the enrolment.

### Recovery codes

1. `replaceRecoveryCodes(id, rawCodes)` hashes each code with SHA-256. An empty code or a repeated one throws `InvalidArgument`. It deletes every code of the identity, then inserts the new hashes in one statement; an empty list only deletes.
2. `redeemRecoveryCode(id, raw)` resolves `false` for a `raw` that is not a non-empty string of at most 1024 characters. Otherwise one `UPDATE` sets `used_at` = now where the identity and hash match and `used_at IS NULL`; it resolves `true` for exactly one caller.
3. `countRecoveryCodes(id)` resolves with the number of unused codes.
4. `removeRecoveryCodes(id)` deletes every code of the identity.

### `DbMfaEnrolmentMarks`

Importing the package registers `DbMfaEnrolmentMarks` under `MfaEnrolmentMarks` (`@PerChildInstance()`, `@Injectable(MfaEnrolmentMarks)`). A mark is a confirmed `authn_mfa` row, so `DbMfaEnrolments` reports the step too: an identity marked in `email-code` while `authn.mfa.steps` does not list it is refused at login. `mark` resolves `false` when the identity is marked already.

### `DbMfaEnrolments`

1. Importing the package registers `DbMfaEnrolments` under `MfaEnrolments` (`@PerChildInstance()`, `@Injectable(MfaEnrolments)`). It gets `DbMfaStore` through `@Autoinject(DbMfaStore)`, or from its constructor argument.
2. `DefaultMfaPolicy` resolves every `MfaEnrolments` registration of the container lineage (`Array.chainOf(MfaEnrolments)`) and asks each one.
3. `stepsOf(id)` calls `DbMfaStore.confirmedSteps(id)`; `stepNames()` calls `DbMfaStore.confirmedStepNames()`.
4. A confirmed step that `authn.mfa.steps` does not list refuses the password login (`MfaStepNotListed`). A confirmed listed step that the step itself does not see refuses it too (`MfaEnrolmentMismatch`). A source that throws refuses the login.
5. `authn:check-config` calls `stepNames()` and reports each confirmed step the list leaves out.

## Configuration

`DbMfaStore` reads no key. The keys that shape what it stores belong to `@spinajs/authn` and `@spinajs/authn-totp`:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.mfa.steps` | `{ name, service }[]` | `[]` | names other than `recovery` | The step names the store keys rows by. |
| `authn.mfa.encryptionKey.secret` | `string \| null` | unset | 32 bytes as 64 hex characters, base64 or base64url | Key a step encrypts `secret_enc` with; its id goes to `key_id`. |
| `authn.mfa.encryptionKey.previous` | `string[]` | unset | as `secret` | Earlier keys, so rows written under them still decrypt. |
| `authn.mfa.totp.recoveryCodes` | `number` | `10` | 0 to 100 | Codes `authn-totp` passes to `replaceRecoveryCodes`. |

See [`@spinajs/authn` MFA](../authn/04-mfa-policy-and-steps.md).

## Schema

### `authn_mfa`

| Column | Type | Meaning |
| --- | --- | --- |
| `identity` | `varchar(100)`, primary key part | `<type>:<id>` of the owner. |
| `step` | `varchar(32)`, primary key part | The step name, for example `totp`. |
| `secret_enc` | `text` | Cipher text exactly as `putPending` got it. |
| `secret_hash` | `varchar(64)` | Hex SHA-256 of `secret_enc`; `confirm` with `expectedSecretEnc` matches on it. |
| `key_id` | `varchar(32)` | Id of the key that wrote `secret_enc`. |
| `confirmed_at` | `datetime`, nullable | Set by `confirm`; `NULL` while enrolment is pending. |
| `last_step` | `bigint`, nullable | The last accepted time step. PostgreSQL returns it as a string; `get` turns it into a number. |
| `created_at` | `datetime` | Time of the last `putPending` that wrote the row. |

### `authn_recovery_code`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `varchar(36)`, primary key | Random UUID. |
| `identity` | `varchar(100)` | `<type>:<id>` of the owner. |
| `code_hash` | `varchar(64)` | Hex SHA-256 of the raw code. Unsalted. |
| `used_at` | `datetime`, nullable | Set by the one successful `redeemRecoveryCode`. |

Index `authn_recovery_code_owner` covers `identity`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| MFA store | `DbMfaStore` (registered as itself), per child container | `DbMfaStore` | none shipped | Subclass `DbMfaStore` and `DI.register(MyStore).as(DbMfaStore)` after this package is imported. |
| Enrolment source | `MfaEnrolments`, per child container, resolved as the list of every registration in the lineage; also registered as `DbMfaEnrolments` | `DbMfaEnrolments` | other `MfaEnrolments` sources | Register another class with `@Injectable(MfaEnrolments)`: it is asked next to `DbMfaEnrolments`, not instead of it. `DbMfaEnrolments` injects `DbMfaStore`, or takes one as its constructor argument. |
| MFA secret store | `MfaSecretStore` (`@spinajs/authn-totp`) | `DbMfaSecretStore`, over `DbMfaStore`, after `import '@spinajs/authn-totp/db'` | `MemoryMfaSecretStore` | See [`@spinajs/authn` MFA](../authn-totp/README.md). |

### MFA store: custom implementation

Subclass `DbMfaStore`, override the methods you need, call `super`, and register the subclass under `DbMfaStore`.

```ts sample
import { DbMfaStore } from '@spinajs/authn-orm';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';

/** Refuses a recovery-code set too small to cover a lost device. */
export class MinimumCodesMfaStore extends DbMfaStore {
  public override async replaceRecoveryCodes(id: IdentityRef, rawCodes: readonly string[]): Promise<void> {
    if (rawCodes.length > 0 && rawCodes.length < 8) {
      throw new InvalidArgument('an MFA enrolment needs at least 8 recovery codes');
    }
    await super.replaceRecoveryCodes(id, rawCodes);
  }
}

DI.register(MinimumCodesMfaStore).as(DbMfaStore);
```

## The MFA cipher

The package also exports the AES-256-GCM cipher a step uses before it calls the store. The same exports are at `@spinajs/authn-orm/cipher`, which loads no store, model or migration; `@spinajs/authn-totp` imports them from there.

| Export | Meaning |
| --- | --- |
| `mfaKeyFrom(secret)` | Reads `authn.mfa.encryptionKey.secret`: 32 bytes as 64 hex characters, base64 (44, or 43 unpadded) or base64url (43). Anything else throws `InvalidOption`, whose message never contains the value. |
| `MfaKey` | `{ key, keyId }`, frozen. `key` is not enumerable, so it stays out of logs and JSON. `keyId` is the first 16 characters of base64url(SHA-256(key)); it goes to `authn_mfa.key_id`. |
| `encryptMfaSecret(key, identity, step, plain)` | AES-256-GCM with a random 12-byte IV and the additional data `<identity>\|<step>`. Returns `v1.<iv>.<tag>.<ct>`, each part base64url. |
| `decryptMfaSecret(key, identity, step, enc)` | The plain text. Throws `InvalidArgument` on a malformed text, another key, a changed text, or another identity or step. |

`identity` is an `IdentityRef`, turned into `<type>:<id>` by `identityKey()`, or that key as a string. A step name containing `|` throws `InvalidArgument`.

## Important behaviour

- `acceptStep` stops code replay in SQL: of parallel calls with one time step, one resolves `true`.
- `putPending` never overwrites a confirmed enrolment; a confirmation that lands first always wins.
- `replaceRecoveryCodes` deletes and then inserts without a transaction. Two parallel calls for one identity can leave both sets.
- Recovery codes are unsalted SHA-256, so a step must generate codes of at least 80 bits. Callers normalise a code (case, dashes) before they pass it.
- On MySQL and MSSQL the default collations ignore case. `get`, `confirmedSteps` and `countRecoveryCodes` check identity and step exactly in Node, but the writes match by the collation; give the identity columns a binary collation there.
- `get` throws `UnexpectedServerError` when `last_step` does not read as a safe integer.
- `putPending` throws `UnexpectedServerError` when a parallel `remove` deletes the row 8 times in a row.

## Best practices

- Pass `expectedSecretEnc` to `confirm` when enrolment confirms a secret the user scanned: a parallel `putPending` that replaced it makes the confirmation fail instead of confirming the new secret.
- Build the identity from `users.Uuid` exactly as stored (`{ type: 'user', id: Uuid }`): the cipher binds the secret to that key, so another spelling does not decrypt.
- Reset a user's MFA through `TotpService.adminReset` of `@spinajs/authn-totp`: it removes the enrolment and the recovery codes together and returns no secret.

## Patterns and antipatterns

```ts
// Don't: a parallel enrolment may have replaced the secret; this confirms whatever is stored now
await mfa.confirm(user, 'totp');

// Do: confirm only the cipher text whose code the user just entered
const confirmed = await mfa.confirm(user, 'totp', new Date(), pendingSecretEnc);
```

## Examples

### Warn a user who is running out of recovery codes

```ts sample
import { DbMfaStore } from '@spinajs/authn-orm';
import { DI } from '@spinajs/di';

export async function recoveryCodesRunningLow(userUuid: string): Promise<boolean> {
  const mfa = await DI.resolve(DbMfaStore);
  const user = { type: 'user', id: userUuid };

  const totp = await mfa.get(user, 'totp');
  if (!totp?.confirmedAt) return false;

  return (await mfa.countRecoveryCodes(user)) < 3;
}
```

### Store a pending authenticator secret, encrypted

```ts sample
import { DbMfaStore, encryptMfaSecret, mfaKeyFrom } from '@spinajs/authn-orm';
import { DI } from '@spinajs/di';

/** False when the user already has a confirmed authenticator; the plain secret never reaches the table. */
export async function startAuthenticatorEnrolment(userUuid: string, plainSecret: string, encryptionKey: string): Promise<boolean> {
  const user = { type: 'user', id: userUuid };
  const key = mfaKeyFrom(encryptionKey);
  const secretEnc = encryptMfaSecret(key, user, 'totp', plainSecret);

  const mfa = await DI.resolve(DbMfaStore);
  return await mfa.putPending(user, 'totp', secretEnc, key.keyId);
}
```

## Related

- [`@spinajs/authn` MFA](../authn/04-mfa-policy-and-steps.md): the policy, the TOTP step and its owner-side service.
- [`@spinajs/authn-totp`](../authn-totp/README.md): `DbMfaSecretStore`, `TotpMfaStep` and the key ring over the MFA cipher.
- [Authentication internals: MFA step](../authn/04-mfa-policy-and-steps.md): where `acceptStep` and recovery codes run in a login.
- [Models and schema](07-models-and-schema.md#authn_mfa): the `AuthnMfa` and `AuthnRecoveryCode` models.
