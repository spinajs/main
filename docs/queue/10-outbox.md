# Transactional outbox

With the outbox enabled, `emit()` inside a database transaction writes the message to a `queue_outbox` table in that transaction instead of publishing it, so the message commits or rolls back with the business change ([What `emit()` does](#what-emit-does)). A relay that runs in the queue service publishes the committed rows right after the commit and on a timer, at least once ([Running the relay](#running-the-relay), [Guarantees](#guarantees)). The outbox is off by default.

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

Outbox times are database time, which `@spinajs/durable` reads from the ORM connection `default`: an app that enables the outbox sets `db.DefaultConnection`. The writer reads the database clock when the queue service resolves (or at the first emit through the outbox), and reads it again in the background on the first emit that comes a minute or more after its last read; the relay reads it on every pass. A queue service that cannot read it fails to resolve with an `InvalidOperation` that names `db.DefaultConnection`.

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

// autoStart: false runs no timer; the caller drives the passes
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

## Running the relay

With `queue.outbox.relay: true` (the default), every process that resolves the queue service runs a relay loop. An app with the outbox enabled resolves the queue service when its Orm boots ([What happens at boot](#what-happens-at-boot)), so the loop starts then, and rows left by an earlier run are published without waiting for a first emit. Emit-only replicas set `relay: false` and leave publishing to the processes that run a relay.

- **On a timer.** The loop runs a pass when it starts, then one pass `queue.outbox.tick` ms after the previous pass ended. Passes never overlap: a pass that takes longer than `tick` delays the next one.
- **After a commit.** A transaction that wrote outbox rows nudges the relay of its own process once the outermost transaction has committed, and a pass runs at once. However many rows the transaction wrote, its commit gives one pass. A commit that lands while a pass is running gets one more pass as soon as that one ends, because the running pass may have read its due rows before the commit. A rolled-back transaction or savepoint nudges nothing, and relays in other processes find the row at their next tick.
- **When a pass fails.** A pass that throws (the database is unreachable, for example) is logged as an error on the `queue` logger, and the loop goes on at the next tick. A failed publish is recorded on its row and does not fail the pass ([Failures, dead rows and retention](#failures-dead-rows-and-retention)). A crash (`crash: true`) stops the loop for good, as the death of the process it stands for.
- **Stopping.** Disposing the queue service (`DI.dispose()`) stops the loop: no new pass starts, the publish in flight finishes and is marked, and the rows of that pass not yet published are released for a later pass. Stopping waits for the pass at most `claimTtl`, after which another relay may take its rows over anyway, so a publish that never returns does not hold up shutdown for longer; the rows behind it then wait out their claims.
- **Several relays.** Every process can run a relay, and several are safe: claims are fenced, so each row goes to one of them. They mostly take turns rather than share a batch, because the first relay to claim a batch holds all of its rows.

The loop's timers run outside the transaction and the request in which they were started: a queue service resolved on first use inside a business transaction does not pull the relay into that transaction.

## Failures, dead rows and retention

A publish that throws (anything but a crash) is recorded on the row, under the relay's claim:

- `Attempts` goes up by one, and `LastError` holds the error's message (its first 4000 characters).
- `PublishedTo` holds the queue connections that confirmed the message so far. A retry skips them, so a message routed to several connections reaches each of them once, however often one of the others fails.
- `AvailableAt` moves forward by the `queue.outbox.backoff` wait for that attempt, and the claim is cleared. A pass before then leaves the row alone.

There is no attempt limit. A row dies by age: the first failure that happens when the row is at least `queue.outbox.maxAge` old (counted from `CreatedAt`, in database time) sets `Status` to `dead` instead of scheduling a retry, and the relay logs an error. Until then the row is retried, so a broker outage shorter than `maxAge` loses nothing.

Age alone never kills a row: a row that is never attempted, because no relay runs, stays `pending`. But once a row is `maxAge` old, its next attempt is its last: if it fails, the row is `dead` at once, whatever the reason. That can be the broker, or something local to the relay: routing names a queue connection that `queue.connections` no longer has, the stored message cannot be read back, or the queue service fails to resolve. The case to plan for is a restart after the app and its broker were both down for longer than `maxAge`: if the relay runs before the broker accepts connections, every row older than `maxAge` that the relay reaches before the broker is back is `dead`. A pass reads at most `batchSize` rows per connection, so a large backlog dies batch by batch, for as many passes as the broker stays unreachable. Set `maxAge` above the longest outage you plan for, start the relay once the broker is reachable, or re-drive the dead rows afterwards (below).

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

## Guarantees

- **The row commits or rolls back with the business change.** A message emitted inside a transaction on an outbox connection is written in that transaction; a rollback, of the transaction or of the savepoint the emit ran in, leaves no row.
- **At least once.** A committed row is published at least once, and can be published more than once ([The relay](#the-relay)).
- **No ordering.** One relay with no failures publishes in `Id` order, but two relays, a failed publish that is retried later, a row the stop rule released, or a second queue connection reorder messages.
- **Consumers must tolerate duplicates.** A job whose `JobId` already finished is skipped (`queue.deduplicate`, on by default). Events will be deduplicated per subscription by `queue.deduplicateEvents` (`12-event-deduplication.md`, arriving with the next release); until then an event handler must tolerate receiving the same event twice.
- **The nudge only shortens the wait.** A nudge that never comes (the process died right after the commit, or the row was written by hand) leaves the row to the next tick of any relay.

## What happens at boot

With `queue.outbox.enabled` set to `true`:

- **The Orm boot checks every outbox connection.** While `Orm.resolve()` collects its migrations, the outbox's migration source takes the driver of each connection in `connections` and compiles the outbox insert on it. A connection that does not exist, or a driver that cannot compile an insert with `orIgnore()`, fails `Orm.resolve()` with `InvalidConfiguration`, which names the connection. This happens before any service exists and before anything emits.
- **The queue service is resolved when the Orm is.** A Bootstrapper of `@spinajs/queue` resolves `QueueService` as soon as the Orm is resolved, without waiting for a first emit. This opens the app's queue connections (one broker connection per `queue.connections` entry) even if the app never emits, and with `relay: true` it starts the relay loop. A failure there is logged on the `queue` logger and met again by the first `DI.resolve(QueueService)`.

A process that runs no Bootstrappers (a script that resolves the Orm by hand) resolves the queue service on first use instead, and the service repeats the connection check then. With the outbox disabled, neither happens.

## Supported databases

SQLite, Postgres and MySQL. On SQL Server the Orm boot fails with the `InvalidConfiguration` of the connection check above ("cannot compile an insert with orIgnore()"), until `@spinajs/orm-mssql` implements `orIgnore()`.

## Operating it

Dead rows, and how to re-drive one: [Failures, dead rows and retention](#failures-dead-rows-and-retention).

Stuck rows:

```sql
-- claimed by a relay that went away; the next pass of any relay takes the row over
SELECT Id, Name, ClaimedBy, ClaimedUntil FROM queue_outbox
WHERE Status = 'pending' AND ClaimedUntil < <now in epoch ms>;

-- failing on every try; LastError says why, and AvailableAt is the next try
SELECT Id, Name, Attempts, AvailableAt, LastError FROM queue_outbox
WHERE Status = 'pending' AND Attempts > 0
ORDER BY Attempts DESC;
```

When rows stay `pending` and nothing publishes them:

- no process runs a relay: every process has `relay: false`, or none resolves the queue service;
- the relay runs but its passes fail: look for "Outbox relay … tick failed" on the `queue` logger (the database is unreachable, or `db.DefaultConnection` is missing);
- the broker is down: `Attempts` and `LastError` grow on each row, and `AvailableAt` moves forward by the backoff.

## Tracing

`TraceParent` holds the `traceparent` header the message carried when it was emitted, if it had the W3C version-00 shape (`00-<trace id>-<span id>-<flags>`); otherwise it is empty.
