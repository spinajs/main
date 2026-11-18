# Trails and guarantees

## The event

`audit().record(input, options)` takes one `AuditInput` or an array of them. The service stamps the rest of an `AuditEvent`:

| Field | Set by | Meaning |
| --- | --- | --- |
| `id` | service | A UUID; what sinks deduplicate on. |
| `at` | input, else service | When it happened. A producer may pass its own `at`. |
| `kind` | input | `data`, `read`, `action`, `security` or `custom`. Any other value is refused. |
| `action` | input | What happened: `update`, `invoice.export`, `login`. 1 to 128 characters. |
| `subject` | input | `{ type, id }` of what it happened to (type up to 128, id up to 255 characters); absent for an action without a single target. |
| `outcome` | input | `ok` (default), `denied`, `failed` or `attempt`. |
| `actor`, `onBehalfOf` | context | `principalKey` of the effective principal, and of the person acting through it when impersonating or under `runAs`. |
| `traceId`, `origin` | context | The request's trace id (32 hex digits) and client address. |
| `tenant`, `decisionId`, `idempotencyKey` | context | Empty unless a registered `AuditContext` returns them. |
| `dataSubject` | input | The person a record is about, as opposed to the row it is (up to 255 characters). |
| `data` | input | The kind-specific payload, after omit, mask and hash. It must be writable as JSON. |

Examples of each kind:

```ts
{ kind: 'data', action: 'update', subject: { type: 'invoice', id: '42' }, data: { before: { status: 'draft' }, after: { status: 'paid' }, changed: ['status'] } }
{ kind: 'read', action: 'patient.read', subject: { type: 'patient', id: '7' }, dataSubject: 'patient:7' }
{ kind: 'action', action: 'invoice.export', outcome: 'denied', data: { format: 'pdf' } }
{ kind: 'security', action: 'login', outcome: 'failed', data: { strategy: 'local', reason: 'bad-password' } }
{ kind: 'custom', action: 'contract.signed', subject: { type: 'contract', id: '9' }, data: { version: 3 } }
```

`kind: 'custom'` with `action: 'erasure'` is reserved for the record `forget` writes ([Erasure](08-erasure.md)): `record()` refuses it with `AuditConfigError`.

Values the context supplies are cut to their column widths (`AUDIT_WIDTHS`); values the input supplies are refused with `AuditConfigError` when they do not fit, so an event is valid for every store or for none.

The context is the `AuditContext` registered in the container, else the ambient one: authz's `Principal` (with `runAs`), else authn's `AuthnPrincipal`, else the unattended principal; http's `traceId`; the `ClientIp`, else `realIp`, of the request store.

## Trails

A trail is a named destination under `audit.trails`. `record` writes to `default` unless `options.trail` names another. A trail is read from configuration on every call, laid over the built-in trail of the same name and the defaults.

| Option | Default | Meaning |
| --- | --- | --- |
| `store` | `TableAuditStore` | Registration name of the `AuditStore`. |
| `table` | `audit_event` | The table of a table store, or the archive table of a shipping trail. `^[A-Za-z_][A-Za-z0-9_]{0,62}$`. |
| `connection` | `default` | ORM connection of confirmed and deferred writes, and of reads without a `source`. |
| `onFailure` | `continue` | `continue` logs a lost event; `reject` throws `AuditWriteFailed` into the caller. |
| `retry` | `{ attempts: 3, delay: 100 }` | `attempts` counts every try, the first included (1 to 10); `delay` is milliseconds or `"100ms"`, `"2s"`, `"1m"`. |
| `integrity` | `none` | `sealed`: see [Integrity and verification](07-integrity-and-verification.md). |
| `omit`, `mask`, `hash` | `[]` | Masking paths, see [Masking](#masking). |
| `retentionDays` | none | Events older than this are pruned; none keeps everything. |
| `sink` | none | Registration name of the `AuditEventSink` of a shipping trail. |
| `reader` | none | Registration name of the `AuditReader` of a shipping trail. |
| `archiveConnection` | none | The connection that holds the archive table of a shipping trail. |

A trail name is a letter followed by up to 63 letters, digits, `_` or `-`. An unknown key in a trail fails the boot: the trail schema names its keys, so a misspelt option is refused, not dropped.

### Built-in trails

| Trail | Store | Notes |
| --- | --- | --- |
| `default` | `TableAuditStore`, table `audit_event` | Needs `@spinajs/audit-orm`. |
| `history` | `TableAuditStore`, table `orm_history` | Needs `@spinajs/audit-orm`. |
| `security` | `LogAuditStore` | One log line per event on the logger `audit.security`; the identifiers of `SECURITY_HASH_PATHS` (`actor`, `onBehalfOf`, `origin`, `data.identity`, `data.actor`, `data.ip`, `data.session`) are hashed. Cannot be read back. |

Configuring a built-in trail overrides its options one by one. Without `@spinajs/audit-orm` a write to `default` fails with `AuditConfigError` naming the package; set the trail's `store` to `LogAuditStore` to log instead.

### Tables

`AuditTrailTableMigration` creates a trail table: `seq` (bigint, autoincrement), the event columns `id` to `data_hash`, and indexes on `(subject_type, subject_id, seq)`, `(actor, seq)`, `trace_id` and `at`. `data` is `LONGTEXT` on MySQL, `TEXT` on Postgres and sqlite, `NVARCHAR(MAX)` on MSSQL. Every text column, `data` included, is declared `exact()`, whatever the database's default: `utf8mb4` with `utf8mb4_bin` on MySQL, `COLLATE "C"` on Postgres, `NVARCHAR` with `Latin1_General_100_BIN2` on MSSQL. So every character is stored as given, and `ABC` and `abc` are different subjects, actors and traces. The buffer, archive and seal tables of [Shipping](06-shipping.md) and [Integrity and verification](07-integrity-and-verification.md) are declared the same way. A query of your own that joins one of these columns to a text column with the default collation needs an explicit `COLLATE` on Postgres and MSSQL, which otherwise refuse to pick one of the two. The package migrates `audit_event` on `default`; for another table or connection, extend the migration:

```ts sample
import { AuditTrailTableMigration } from '@spinajs/audit-orm';
import { Migration } from '@spinajs/orm';

@Migration('default')
export class AuditBilling_2026_11_17_00_00_00 extends AuditTrailTableMigration {
  protected override table(): string {
    return 'audit_billing';
  }
}
```

**One table per trail, on every connection.** A trail table has no trail column, and transactional events sit on the connection of each audited write, so two table trails that name the same table would read, erase and prune each other's events whatever their connections. The later of the two (built-in trails first, then configuration order) is refused with `AuditConfigError` on write, read and retention; the first keeps working. A configured table trail without its own `table` gets `audit_event` and therefore collides with `default`. The tables `audit_outbox` and `audit_seal` are reserved: a trail that names one is refused. The check reads the trails of the root container's configuration and the store classes registered there: trails a child container configures on its own, and a store registered through a factory, are not checked.

## Write modes

| Mode | Default when | Where the event goes | When `record` returns |
| --- | --- | --- | --- |
| `transactional` | never; ask for it | Into the caller's open transaction, handed as `options.transaction` (the `OrmDriver` of the audited write). | After the insert, inside the transaction: the event commits and rolls back with the audited write. |
| `confirmed` | the effective `onFailure` is `reject` | Its own write on the trail's connection, or on `options.connection`. | When the store confirmed it, or failed. |
| `deferred` | the effective `onFailure` is `continue` | An in-memory buffer, written in batches in the background. | At once. |

The caller chooses the mode with `options.mode`; `options.onFailure` overrides the trail's.

- **Transactional.** Needs a store with `joinsTransaction` (`TableAuditStore`, `OutboxAuditStore`); `LogAuditStore` is refused. It is tried once (a second statement in a failed Postgres transaction cannot succeed) and always throws on failure, whatever `onFailure` says: the audited write must fail with its record. A failed insert throws `AuditWriteFailed`; a configuration error of the store (a table another trail already uses, a transaction that is not an `OrmDriver`) keeps its own type, `AuditConfigError`.
- **Confirmed.** Tried up to `retry.attempts` times, `retry.delay` apart, within `audit.confirmTimeoutMs` (default 10000 ms) for all tries. At the deadline the caller is told the write failed; an append already under way cannot be recalled and may still store the event, which is logged as an error on a `reject` trail.
- **Deferred.** Buffered and flushed every `audit.deferred.flushMs` (1000) in batches of `maxBatch` (500); at most `maxBuffered` (10000) events wait, and events beyond that are dropped and logged. Each batch has `timeoutMs` (2000) for its tries. A batch whose append outlives its deadline blocks its trail and connection: later batches there are dropped until it settles or `audit.deferred.blockCeilingMs` (default 10 × `timeoutMs`) has passed. After the ceiling the trail writes again and **ordering is not guaranteed** against the held append. A deferred write on a `reject` trail is refused. Disposing the container flushes the buffer; a crash loses it.

Every lost or late event is logged on the logger `audit-pipeline` with the trail, the count and up to 20 ids. A broken logger never changes the outcome of a write: the line becomes a process warning.

### A confirmed write inside a transaction

Whether a confirmed event survives the rollback of a transaction open on the connection it is written to depends on the driver.

- **Pooled drivers (Postgres, MySQL, MSSQL).** The event is written on a connection of its own and is kept when the caller's transaction rolls back. That needs a pool of at least two connections; with one, the write waits for the caller's transaction and fails at `audit.confirmTimeoutMs`.
- **sqlite and PGlite** (one transaction at a time). When the caller holds a transaction open on that connection, the write **joins** it: attempted once, inside a savepoint, without retries and without a deadline, and it **rolls back with the caller**. Record the audit of a refused or failed action after the transaction that is rolled back, not inside it. Connections that share one PGlite instance (`Options.Shared`) are not detected as one: a confirmed write to one while another holds a transaction waits and fails at the deadline.

Joined writes of one transaction run one after another. A failed one leaves the caller's transaction usable: a `reject` trail throws `AuditWriteFailed`, a `continue` trail logs the loss. Await every `record` before the transaction ends; a joined write left running may land after it ended. So never `Promise.all` over `record()` inside a transaction: when one rejects, `Promise.all` returns while the others still run. Use `Promise.allSettled`, as below. Do not run a nested `driver.transaction()` in parallel with a `record` in the same transaction either: their savepoints interleave.

```ts sample
import { audit } from '@spinajs/audit';
import type { AuditInput } from '@spinajs/audit';
import type { OrmDriver } from '@spinajs/orm';

export async function closeAll(driver: OrmDriver, ids: string[]): Promise<void> {
  await driver.transaction(async () => {
    await driver.update().in('invoice').update({ status: 'closed' }).whereIn('id', ids);
    const events: AuditInput[] = ids.map((id) => ({ kind: 'data', action: 'update', subject: { type: 'invoice', id }, data: { after: { status: 'closed' } } }));
    const results = await Promise.allSettled(events.map((e) => audit().record(e, { mode: 'confirmed', onFailure: 'reject' })));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  });
}
```

The transactional mode of the same write is one call: `audit().record(events, { mode: 'transactional', transaction: driver })`.

## Masking

`omit`, `mask` and `hash` take paths: `data.<path>` with `*` for any key or array element and a number for one element (counted in the list as earlier `omit` paths left it: omitting `data.tags.0` moves the next element to 0), or one of the top-level fields `actor`, `onBehalfOf`, `origin`, `dataSubject` (`actor` cannot be omitted). The trail's lists are united with the call's, then applied in order: omit removes, mask writes `***`, hash writes an HMAC-SHA256 (base64url) of the value: a string as it is, a bigint as its decimal text, anything else as its canonical JSON. A number below 1e21 therefore hashes like the same identifier written as a string or a bigint (from 1e21 up JSON writes an exponent, and it no longer matches its bigint); a `Date`, or any value whose JSON is a string, hashes as that JSON string with its quotes, so it does not match the same text stored as a string. A path enters class instances as plain objects; a `Map` or `Set` it runs through is written as an empty object.

The hash key is `audit.hashKey.secret` (at least 32 characters). Without it each process draws a random key, so a hashed value is comparable only within one process: on a trail that is kept, set the secret.

## Retention

A trail with `retentionDays` loses older events to `pruneAudit()`, which `AuditRetentionTask` (`@spinajs/audit-orm/scheduler`, schedule `audit.retention`) runs daily on the leader. It prunes each connection that holds a table of the trail's name with the columns `seq`, `at` and `data_hash`, or, for a trail with an archive, the archive once for every source. A trail or connection that fails does not stop the others: they are pruned, then `AuditPruneFailed` names the failures and the count. A sealed trail loses whole sealed ranges only ([Integrity and verification](07-integrity-and-verification.md#retention)).

## One service per container

`audit(container?)` resolves the `AuditService` of a container; it is one per container and reads `audit.*` through that container's configuration. Stores, sinks and readers are found by registration name: `@Injectable(AuditStore) class X` registers as `'X'`.

## Limits

- A deferred event can be lost on a crash or when the buffer is full; only `transactional` and `confirmed` writes are acknowledged.
- A `reject` trail is an availability dependency: when its store is down, the audited operations fail.
- On sqlite and PGlite a confirmed event recorded inside a transaction that rolls back is gone.
- Hashed values are comparable across restarts and processes only with `audit.hashKey.secret`.
