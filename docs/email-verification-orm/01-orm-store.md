# ORM store

`OrmEmailVerificationStore` implements `EmailVerificationStore` with raw `OrmDriver` queries on one connection. Use it when the app already runs a SQL database and migrations.

## How it works

1. Importing the package registers `OrmEmailVerificationStore` under the `EmailVerificationStore` token and the migration `EmailVerification_2026_10_21_00_00_00`.
2. Set `emailVerification.store` to `'OrmEmailVerificationStore'`.
3. On `resolve()` the store starts the cleanup timer (`unref`ed, so it never keeps the process alive). Every query gets its driver from `Orm.Connections` by `emailVerification.orm.connection`; an unknown name throws `InvalidOperation` listing the known connections.
4. Verdicts are one row each, keyed `<verifier>:<domain>`. A read ignores an expired row.
5. Lists are stored as **generations**. A source row (`<kind>|<source>`) points at its live generation. A write:
   1. inserts the new entries under a fresh generation id, 200 rows per insert;
   2. moves the source pointer with a compare-and-set on the old generation;
   3. bumps `listVersion` (a new UUID in the meta table);
   4. deletes the old generation's rows.
6. If another writer moved the pointer first, the write drops its own generation and retries, up to 5 attempts, then throws `InvalidOperation`.
7. `loadLists()` reads the pointers, the entries, and the pointers again. If any pointer moved it retries, up to 5 attempts. A reader therefore never returns a half-replaced source. No transaction is used.

## Migration

The migration runs on the connection named by `emailVerification.orm.connection` (read when the migrations run), default `email-verification-connection`. Define that connection with `Migration.OnStartup: true`, or run the migration yourself.

### `email_verification_verdicts`

| Column | Type | Meaning |
| --- | --- | --- |
| `key` | `string(300)`, primary key | `<verifier>:<domain>` |
| `result` | `string(8)` | `allow`, `refuse` or `unknown` |
| `reason` | `string(64)`, null | Verdict reason |
| `source` | `string(80)`, null | Verdict source |
| `checked_at` | `bigint` | Epoch ms of the check |
| `expires_at` | `bigint` | Epoch ms; indexed as `ev_verdicts_expires` |

### `email_verification_sources`

| Column | Type | Meaning |
| --- | --- | --- |
| `key` | `string(80)`, primary key | `<kind>\|<source>` |
| `gen` | `string(36)` | The live generation |

### `email_verification_entries`

| Column | Type | Meaning |
| --- | --- | --- |
| `key` | `string(300)`, primary key | `<gen>\|<domain>` |
| `gen` | `string(36)` | Generation id |
| `domain` | `string(253)` | Domain |
| `created_at` | `bigint` | Epoch ms the generation was written; indexed with `gen` as `ev_entries_gen_created` |

### `email_verification_meta`

| Column | Type | Meaning |
| --- | --- | --- |
| `key` | `string(128)`, primary key | Sync state (`sync:<source>:etag`, `:count`, `:origin`, `:pendingClear`) and `listVersion` |
| `value` | `text` | The value |

`down()` drops the four tables.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `emailVerification.store` | `string` | `'MemoryEmailVerificationStore'` | `'OrmEmailVerificationStore'` | Selects this store |
| `emailVerification.orm.connection` | `string` | `'email-verification-connection'` | A configured ORM connection | Connection for queries and for the migration |
| `emailVerification.orm.cleanupIntervalMs` | `integer` | `600000` | `>= 1000` | Cleanup period |

```ts
export default {
  emailVerification: {
    store: 'OrmEmailVerificationStore',
    orm: { connection: 'main-db', cleanupIntervalMs: 300000 },
  },
};
```

## Cleanup sweep

`cleanupExpired()` runs every `cleanupIntervalMs`, and you may call it yourself. It returns the number of rows removed.

1. Deletes verdict rows whose `expires_at` has passed, in batches of 500.
2. Deletes entry rows of generations that no source points at (left by a write that failed halfway) and whose newest row is older than one hour.

A tick that finds the previous sweep still running is skipped. A failure is logged and the next tick retries.

## Important behaviour

- **Clocks must agree.** Expiry and the one-hour grace of the sweep compare `Date.now()` values written by different nodes. Keep all nodes' clocks within the 1 h grace (use NTP). A writer that stalls for longer than the grace can lose its unfinished generation to the sweep.
- Verdict rows are only removed by the sweep; a read treats an expired row as missing at once.
- A write that errors after the pointer moved is detected by re-reading the pointer, so a retry does not duplicate work. If that re-read fails too, the original write error is thrown.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Store | `EmailVerificationStore`, singleton, by class name | `OrmEmailVerificationStore` | Memory, Redis, DynamoDB | Subclass and override protected methods such as `runCleanup()`; decorate with `@Injectable(EmailVerificationStore)` and set `emailVerification.store` to the subclass name. See [custom stores](../email-verification/07-custom-verifiers-and-stores.md#custom-emailverificationstore). |

## Related

- [Choosing a store](../email-verification/06-choosing-a-store.md)
- [`@spinajs/orm` connections](../orm/01-connections.md)
