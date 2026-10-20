# Secret store

`MfaSecretStore` is where `TotpMfaStep` keeps the encrypted TOTP secret, the confirmation, the last accepted time step and the recovery-code hashes of each identity. The package ships `DbMfaSecretStore` for apps and `MemoryMfaSecretStore` for tests; any other storage plugs in by registering a subclass.

## How it works

1. `MfaSecretStore` is an abstract class. No implementation is registered by the root entry.
2. `import '@spinajs/authn-totp/db'` loads `DbMfaSecretStore`, decorated `@PerChildInstance()` and `@Injectable(MfaSecretStore)`. It injects `DbMfaStore` of `@spinajs/authn-orm` and passes each call on to it.
3. `TotpMfaStep` resolves `MfaSecretStore` on first use (optional injection). With none registered, its first call throws `InvalidOperation` naming `MfaSecretStore` and `@spinajs/authn-totp/db`.
4. Every store keys rows by `identityKey(id)` of `@spinajs/authn-orm/identity` (`<type>:<id>`) and the step name (`totp`). Stores never encrypt or decrypt: they keep the cipher text `TotpMfaStep` hands them.

### The contract

| Method | Must do |
| --- | --- |
| `get(id, step)` | Return the `MfaRecord` of `@spinajs/authn-orm`, re-exported as a type (`secretEnc`, `keyId`, `confirmedAt`, `lastStep`, `createdAt`), or `null`. |
| `put(id, step, secretEnc, keyId)` | Insert an unconfirmed row, or replace an unconfirmed one (`lastStep` `null`, `createdAt` now), and return `true`. Never overwrite a confirmed row: return `false` and change nothing. |
| `confirm(id, step, at?, expectedSecretEnc?)` | Set `confirmedAt` (default now) on an unconfirmed row that holds `expectedSecretEnc` when one is given. Return `true` only for the call that made the change: one atomic conditional write. |
| `acceptStep(id, step, timeStep)` | Store `timeStep` when it is above `lastStep` and return `true`. Return `false` for a step at or below `lastStep`, and without a row. Atomic. |
| `remove(id, step)` | Delete the row. |
| `replaceRecoveryCodes(id, rawCodes)` | Void the old set and store the SHA-256 hex of each code. Throw for an empty or repeated code. |
| `redeemRecoveryCode(id, raw)` | Mark an unused code used. `true` for exactly one caller. |
| `countRecoveryCodes(id)` | Count the unused codes. |
| `removeRecoveryCodes(id)` | Delete every code of the identity. |

### Row key

`identityKey(ref, maxLength = 100)` of `@spinajs/authn-orm/identity`, a subpath that loads no migration or DB store, returns `` `${ref.type}:${ref.id}` ``, the row key `DbMfaStore` uses. It throws `InvalidArgument` when `type` is empty or contains `:`, and when the key is longer than `maxLength` (the `identity` column holds 100 characters). It never truncates.

## Schema

`DbMfaSecretStore` writes `authn_mfa` (one row per identity and step) and `authn_recovery_code` (one row per code). Both tables and their migration belong to `@spinajs/authn-orm`: [MFA store](../authn-orm/05-mfa-store.md).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Secret store | `MfaSecretStore`; `DbMfaSecretStore` is `@PerChildInstance()` | none; `DbMfaSecretStore` after `import '@spinajs/authn-totp/db'` | `MemoryMfaSecretStore` (in process, not registered) | `DI.register(MyStore).as(MfaSecretStore)` after the `/db` import and before the first TOTP call; or subclass `DbMfaSecretStore`. |
| DB backend | `DbMfaStore` of `@spinajs/authn-orm`, `@PerChildInstance()` | `DbMfaStore` | | Replace it in `@spinajs/authn-orm`, or pass one to `new DbMfaSecretStore(db)`. |

### `DbMfaSecretStore`

- `put` calls `DbMfaStore.putPending`, which refuses to overwrite a confirmed row.
- `confirm` without `expectedSecretEnc` reads the row first and confirms its current cipher text, so a confirmed row still returns `false`.
- `confirm` throws `InvalidArgument` for an `at` that is not a valid date.
- Its constructor takes an optional `DbMfaStore`; DI passes none and injects one.

### `MemoryMfaSecretStore`

- Keeps rows and code hashes in `Map`s of the process. It loses every enrolment on restart and is not shared between processes.
- Returns frozen copies from `get`.
- Adds `recoveryCodeHashes(id)`, the stored SHA-256 hashes, for storage checks in tests.
- Not registered in DI: register it yourself with `DI.register(MemoryMfaSecretStore).as(MfaSecretStore)`.

### Secret store: custom implementation

Replace the store to keep secrets elsewhere, or subclass `DbMfaSecretStore` to add behaviour around a call. Keep `put`, `confirm`, `acceptStep` and `redeemRecoveryCode` atomic: replay protection, race-safe enrolment and single-use codes rely on them. Register the class after `import '@spinajs/authn-totp/db'`, before the first TOTP call.

```ts sample
import { MfaSecretStore } from '@spinajs/authn-totp';
import { DbMfaSecretStore } from '@spinajs/authn-totp/db';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { DI } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';

/** Logs each used recovery code, so support can reach a user who may have lost the device. */
export class AlertingMfaSecretStore extends DbMfaSecretStore {
  @Logger('authn-totp')
  protected Log: Log;

  public override async redeemRecoveryCode(id: IdentityRef, raw: string): Promise<boolean> {
    const used = await super.redeemRecoveryCode(id, raw);
    if (used) {
      this.Log.warn({ identity: `${id.type}:${id.id}` }, 'recovery code used by ${identity}');
    }
    return used;
  }
}

DI.register(AlertingMfaSecretStore).as(MfaSecretStore);
```

## Important behaviour

- Importing `@spinajs/authn-totp/db` loads all of `@spinajs/authn-orm`, with its migration, `DbAuthnThrottle`, `DbAuthnAuditSink` and other DB stores. The root entry does not.
- `MfaSecretStore` is resolved once per `TotpMfaStep` instance and kept. Register a replacement before the first TOTP call.
- The cipher text is bound to `<identity>|<step>`. Build the identity exactly as stored (`{ type: 'user', id: <users.Uuid> }`); another spelling does not decrypt.
- On MySQL and MSSQL the default collations ignore case in the identity column; see [MFA store](../authn-orm/05-mfa-store.md).

## Best practices

- Use `MemoryMfaSecretStore` in unit tests and `DbMfaSecretStore` (with `@spinajs/orm-sqlite`) in integration tests.
- Reach the TOTP data through `TotpMfaStep` or `TotpService`, not through the store: the store holds cipher text and does not audit.

## Patterns and antipatterns

```ts
// Don't: read, then write; two parallel logins with the same code both get true
const row = await this.get(id, step);
if (row && (row.lastStep === null || row.lastStep < timeStep)) {
  await this.save({ ...row, lastStep: timeStep });
  return true;
}

// Do: one conditional write that only one caller can win, as DbMfaStore does:
// UPDATE authn_mfa SET last_step = ? WHERE identity = ? AND step = ? AND (last_step IS NULL OR last_step < ?)
```

## Examples

### Unit-test an enrolment against the memory store

```ts sample
import { MemoryMfaSecretStore, TotpMfaStep, mfaKeyRingFrom } from '@spinajs/authn-totp';
import { randomBytes } from 'node:crypto';

export async function enrolTestUser(): Promise<{ store: MemoryMfaSecretStore; provisioning: string }> {
  const store = new MemoryMfaSecretStore();
  const step = new TotpMfaStep({
    store,
    keys: mfaKeyRingFrom({ secret: randomBytes(32).toString('hex') }),
    options: { issuer: 'Acme Test', algorithm: 'SHA1', digits: 6, period: 30, window: 1, recoveryCodes: 10 },
    identities: null,
  });
  const { provisioning } = await step.beginEnrolment({ type: 'user', id: '7f1c9a2e-0d4b-4c1e-9a55-2b8f3c6d1e40' });
  return { store, provisioning };
}
```

## Related

- [`@spinajs/authn-orm` MFA store](../authn-orm/05-mfa-store.md): `DbMfaStore`, the tables and the SQL behind each call.
- [Encryption keys](07-encryption-keys.md): what produces `secretEnc` and `keyId`.
- [Wiring and testing](09-wiring-and-testing.md): passing a store to `TotpMfaStep` directly.
