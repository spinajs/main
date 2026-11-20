# Transactional outbox

The outbox is being built up over several releases of 4.x. What works so far: the `queue.outbox` configuration is validated at boot, and with `queue.outbox.enabled` set to `true` the `queue_outbox` table is created on every database that `queue.outbox.connections` names, and `emit()` inside a transaction writes a row to it instead of publishing ([What `emit()` does](#what-emit-does)), and `OutboxRelay.tick()` publishes the committed rows, retries the ones whose publish failed and deletes old published rows ([The relay](#the-relay), [Failures, dead rows and retention](#failures-dead-rows-and-retention)). Nothing calls `tick()` on a timer yet: the loop that drives it arrives in a later release.

## Configuration

The outbox is off by default. Every key under `queue.outbox`, with its default from `OUTBOX_DEFAULTS`:

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.outbox.enabled` | `boolean` | `false` | Turns the outbox on: the `queue_outbox` table is created on every connection in `connections`. |
| `queue.outbox.relay` | `boolean` | `true` | Whether this process runs the relay that publishes outbox rows; emit-only replicas set `false`. |
| `queue.outbox.connections` | `string[]` | `['default']` | The ORM connections that hold the business transactions whose messages go through the outbox. At least one. |
| `queue.outbox.mode` | `'when-in-transaction'` \| `'always'` | `'when-in-transaction'` | When an emit goes through the outbox: only inside a transaction, or always. |
| `queue.outbox.tick` | `number` (ms) | `1000` | Time between two relay passes; at least `10`. |
| `queue.outbox.batchSize` | `number` | `100` | Rows one relay pass reads at most; `1` to `1000`. |
| `queue.outbox.claimTtl` | `number` (ms) | `30000` | How long a relay's claim on a row holds; at least `1000`. |
| `queue.outbox.maxPublishMs` | `number` (ms) | `10000` | How long one publish is expected to take at most; a row its claim can no longer cover is released unpublished, for a later pass. An estimate, not a timeout. Must be below `claimTtl`. |
| `queue.outbox.maxAge` | duration | `'24h'` | A row whose publish still fails once it is this old (counted from its creation) becomes `dead`; younger rows are retried. Above zero. |
| `queue.outbox.backoff.backoff` | `'fixed'` \| `'exponential'` | `'exponential'` | How the wait between two failed publishes of a row grows. |
| `queue.outbox.backoff.delay` | duration | `'1s'` | The first wait after a failed publish. |
| `queue.outbox.backoff.maxDelay` | duration | `'5m'` | The longest wait of an exponential backoff. |
| `queue.outbox.retention` | duration | `'7d'` | How long a published row is kept before it is deleted. |

```ts
// config/queue.ts
export default {
  db: { DefaultConnection: 'orders' },
  queue: {
    outbox: {
      enabled: true,
      connections: ['orders', 'billing'],
      maxAge: '12h',
      backoff: { backoff: 'exponential', delay: '2s', maxDelay: '10m' },
    },
  },
};
```

`connections` names ORM connections as `db.Connections`, `db.DefaultConnection` (as `default`) and `db.Aliases` know them. `default` and aliases are resolved first, so two names of one database (`default` and the connection it points at, or an alias and its target) give one table, created once. `connections` has its default only in code, never in a shipped configuration file, because configuration arrays from several sources are concatenated.

Two separately named entries of `db.Connections` that reach the same database fail the boot with "table queue_outbox already exists": list one of the names in `connections`, or make the other an alias in `db.Aliases`.

The schema checks every value at boot. Beyond that, the values of a disabled outbox are not checked: an empty `connections` list or `maxPublishMs` above `claimTtl` fails the boot only once `enabled` is `true`.

A duration (`maxAge`, `retention`, `backoff.delay`, `backoff.maxDelay`) is a whole number of milliseconds or a string with a unit: `500ms`, `10s`, `5m`, `2h`, `30d`, `1w`. A numeric string such as `'86400000'` is read as milliseconds. Anything else (`null`, `true`, an empty string, `1.5`, a word) fails the boot. Zero: `maxAge` must be above zero; `retention: 0` keeps no published row, each is deleted by the first purge after it was published; `backoff.delay: 0` retries on the next pass.

**Unknown keys under `queue.outbox` are dropped by the configuration validator, without an error or a log line.** A misspelt key therefore has no effect: check the spelling against the table above when a setting seems to be ignored.

Outbox times are database time, which `@spinajs/durable` reads from the ORM connection `default`: an app that enables the outbox sets `db.DefaultConnection`. The writer reads the database clock once, when the queue service resolves (or at the first emit through the outbox), and the relay reads it again on every pass.

## What `emit()` does

With the outbox enabled, `emit()` looks at every ORM connection for a transaction open on the async path that is emitting, and decides:

| Outbox connections with an open transaction | Other connections with an open transaction | Result |
| --- | --- | --- |
| exactly one | any | The row is written in that transaction and commits or rolls back with it. Nothing is published. |
| more than one | any | `OutboxAmbiguousTransaction` |
| none | at least one | `OutboxConnectionNotCovered` |
| none | none | `mode: 'when-in-transaction'`: published directly, as without the outbox. `mode: 'always'`: a row is written in autocommit on the first connection of `connections`. |

- **`OutboxAmbiguousTransaction`**: transactions are open on several outbox connections, so the row has no single transaction to join. Emit inside one of them only. `error.connections` names them.
- **`OutboxConnectionNotCovered`**: a transaction is open on an ORM connection that `queue.outbox.connections` does not list, so the message could not roll back with it. Add the connection the message names (`error.connections`) to `queue.outbox.connections`, or emit from `afterCommit()`. This holds in both modes: in `'always'` mode the autocommit row would survive the rollback of that transaction.

With the outbox disabled, nothing is checked and `emit()` publishes directly.

Before anything is written, `emit()` checks that every queue connection the message is routed to exists, so a misrouted message fails the caller instead of waiting in the outbox. `emit()` still returns the `JobId` of a job. A `MessageId` (set by the caller, or generated by `emit()`) is at most 128 characters long; a longer one is refused with `InvalidArgument` and nothing is written.

The row is written with insert-or-ignore, so a `MessageId` the table already holds writes nothing. What `emit()` does then depends on the stored row:

| Stored row | Result | What the caller does |
| --- | --- | --- |
| the same message (`Name` and `Type` equal), `pending` or `published` | accepted | nothing: a retried business transaction emitted the same message again, and it is or will be published once |
| another message (`Name` or `Type` differs) | `OutboxMessageIdConflict` | emit with a new `MessageId` |
| `dead` | `OutboxMessageIdConflict` | re-drive or delete the row, or emit with a new `MessageId` |
| not readable by this transaction: committed after its snapshot (MySQL and Postgres under REPEATABLE READ) | `OutboxMessageIdConflict` | retry the transaction |

The throw is an ordinary rejection of `emit()`: nothing was written, and on Postgres the transaction is still usable, because the ignored insert raised no error. `MessageId` is compared exactly: `'Order-1'` and `'order-1'` are two ids on every database. MySQL and SQL Server compare two ids that differ only in trailing spaces (`'a1'` and `'a1 '`) as equal; such an emit throws `OutboxMessageIdConflict` too, and is not accepted as a repeat.

`QueueService.publishDirect(message, { skip, published })` sends to the brokers now and bypasses the outbox: it skips the queue connections listed in `skip` and pushes every connection that confirmed the message to `published`. The relay publishes rows through it.

## The relay

`OutboxRelay` publishes the rows. One `tick()` makes one pass over every connection in `queue.outbox.connections`, one connection after the other:

1. It reads up to `batchSize` due rows, in `Id` order: `pending`, `AvailableAt` reached, and either unclaimed or with a claim that ended.
2. It claims each row it read, one statement per row. A claim is a compare-and-set on the row's `ClaimEpoch` as it was read: it sets `ClaimedBy` to the relay's `replicaId`, `ClaimedUntil` to the time of that claim plus `claimTtl`, and moves the epoch by one. A row that another relay claimed since it was read is lost to this one, even if that relay has let it go again.
3. It publishes each claimed row through `QueueService.publishDirect`, skipping the queue connections in the row's `PublishedTo`, and then marks it `published` with the connections that confirmed it in `PublishedTo`.

Concurrent calls of `tick()` on one relay share the pass in progress. Several relays, in one process (one per `replicaId`, `DI.resolve(OutboxRelay, [{ replicaId }])`) or in several, drain the same table in parallel: each row goes to the relay whose claim won.

```ts
import { DI } from '@spinajs/di';
import { OutboxRelay } from '@spinajs/queue';

const relay = await DI.resolve(OutboxRelay, [{ replicaId: 'reports-1', autoStart: false }]);
await relay.tick();
```

**Fenced writes.** The mark, the failure record and the release of a row change the row only while it still carries the relay's `ClaimedBy` and the epoch of its claim. A relay whose claim ended and was taken over by another relay can still finish a publish it had started, but it can no longer mark the row, record its failure or release it: each refused write logs a warning on the `queue` logger, and the row is left to its new owner.

**The stop rule.** Before each publish, the relay checks that the row's claim still covers it: when now plus `maxPublishMs` is past that claim's end, it releases the row, unpublished, and goes on with the next one; a later pass claims the row again. Each claim runs from its own statement, so the rows claimed last have the most time left: a database whose claim statements are slow makes the relay publish fewer rows per pass, not none. `maxPublishMs` is an estimate the stop rule uses, not a timeout: a single publish that takes longer than its claim has left is published a second time by another relay once the claim ends. `claimTtl` must therefore exceed the transport's worst confirm time.

**A failed publish** is recorded on the row, which a later pass retries after the backoff, and the pass goes on with the next row ([Failures, dead rows and retention](#failures-dead-rows-and-retention)). A crash (an error with `crash: true`, which stands for a dead process) leaves the pass before anything is written: the row keeps its claim, and another relay takes it over once the claim ends.

What the relay guarantees, and what it does not:

- **At least once.** A committed row is published at least once. A crash between publish and mark, or a publish that outlives its claim, publishes it again. A message routed to several queue connections is sent again to the connections that confirmed it only when a failure on another connection could not be recorded: the relay crashed, had lost its claim, or could not write to the database; a recorded failure keeps the confirmed connections in `PublishedTo`, and the retry skips them. Consumers must therefore treat a repeat of a `MessageId` as normal: a job whose `JobId` already finished is skipped (`queue.deduplicate`, on by default), and an event handler must tolerate receiving the same event twice.
- **Fenced writes.** Every mark, failure record and release is fenced by `ClaimedBy` and `ClaimEpoch`, so a relay that lost its claim changes nothing.
- **No ordering.** One relay with no failures publishes in `Id` order, but two relays, a failed publish that is retried later, a row the stop rule released, or a second queue connection reorder messages.

## Failures, dead rows and retention

A publish that throws (anything but a crash) is recorded on the row, under the relay's claim:

- `Attempts` goes up by one, and `LastError` holds the error's message (its first 4000 characters).
- `PublishedTo` holds the queue connections that confirmed the message so far. A retry skips them, so a message routed to several connections reaches each of them once, however often one of the others fails.
- `AvailableAt` moves forward by the `queue.outbox.backoff` wait for that attempt, and the claim is cleared. A pass before then leaves the row alone.

There is no attempt limit. A row dies by age: the first failure that happens when the row is at least `queue.outbox.maxAge` old (counted from `CreatedAt`, in database time) sets `Status` to `dead` instead of scheduling a retry, and the relay logs an error. Until then the row is retried, so a broker outage shorter than `maxAge` loses nothing.

Age alone never kills a row: a row that is never attempted, because no relay runs, stays `pending`. But once a row is `maxAge` old, its next attempt is its last: if it fails, the row is `dead` at once, whatever the reason. That can be the broker, or something local to the relay: routing names a queue connection that `queue.connections` no longer has, the stored message cannot be read back, or the queue service fails to resolve. The case to plan for is a restart after the app and its broker were both down for longer than `maxAge`: if the relay runs its first pass before the broker accepts connections, every row older than `maxAge` is `dead` after that pass. Set `maxAge` above the longest outage you plan for, start the relay once the broker is reachable, or re-drive the dead rows afterwards (below).

An example with the defaults (`backoff` exponential from `1s` to `5m`, `maxAge` `24h`): RabbitMQ is down for 90 minutes. Every row emitted meanwhile fails, and its waits grow 1 s, 2 s, 4 s and so on until they reach 5 minutes; from then on it is retried every 5 minutes, and published within about 5 minutes of the broker's return. Nothing dies, because no row is 24 hours old. A row still failing after a day is tried about 300 times before it dies.

**Retention.** After each pass over a connection, at most once per `retention / 100` (and at least one second apart), the relay deletes the `published` rows whose `PublishedAt` is more than `retention` ago, `batchSize` rows per statement, until a statement deletes fewer than `batchSize`. A row an operator re-drove between the select and the delete stays. `pending` and `dead` rows are never deleted: dead rows stay until an operator deletes or re-drives them.

Dead rows:

```sql
SELECT Id, Name, Attempts, LastError FROM queue_outbox WHERE Status = 'dead';
```

Re-driving one:

```sql
UPDATE queue_outbox SET Status = 'pending', AvailableAt = 0, CreatedAt = <now in epoch ms> WHERE Id = <id>;
```

`CreatedAt` must move, or the row dies again at its next failure. The re-driven row keeps its `PublishedTo`, so the connections that confirmed it are not sent to again.

## What happens at boot

With `queue.outbox.enabled` set to `true`:

- **The Orm boot checks every outbox connection.** While `Orm.resolve()` collects its migrations, the outbox's migration source takes the driver of each connection in `connections` and compiles the outbox insert on it. A connection that does not exist, or a driver that cannot compile an insert with `orIgnore()`, fails `Orm.resolve()` with `InvalidConfiguration`, which names the connection. This happens before any service exists and before anything emits.
- **The queue service is resolved when the Orm is.** A Bootstrapper of `@spinajs/queue` resolves `QueueService` as soon as the Orm is resolved, without waiting for a first emit. This opens the app's queue connections (one broker connection per `queue.connections` entry) even if the app never emits. A failure there is logged on the `queue` logger and met again by the first `DI.resolve(QueueService)`.

A process that runs no Bootstrappers (a script that resolves the Orm by hand) resolves the queue service on first use instead, and the service repeats the connection check then. With the outbox disabled, neither happens.

SQL Server: the boot fails until `@spinajs/orm-mssql` implements `orIgnore()`.
