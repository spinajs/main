# Limits

What a reader of the trail, and an operator of it, must not assume.

## Recording

- **Deferred events can be lost.** A crash loses the in-memory buffer; a full buffer (`audit.deferred.maxBuffered`) drops events; a trail blocked behind an append that does not settle drops its deferred batches until `audit.deferred.blockCeilingMs`, after which ordering against the held append is not guaranteed. Every loss is logged on `audit-pipeline`, nothing more.
- **A confirmed write given up at `audit.confirmTimeoutMs` may still land.** The caller was told it failed; a retried operation can then leave two events. The late landing is logged.
- **A rejecting trail is an availability dependency.** With `onFailure: 'reject'` the audited operation fails when the trail's store is down.
- **sqlite and PGlite:** a confirmed event recorded inside a transaction that rolls back is rolled back with it. Connections that share one PGlite instance wait for each other's transactions.
- **Inside a transaction, await every `record`;** never `Promise.all` them (use `Promise.allSettled`), or a joined write may land after the transaction ended.
- **Configuration is checked at boot, not all of it alike.** An unknown key in a trail, in `audit.deferred`, `audit.hashKey` or `audit.seal` fails the boot. An unknown key in `audit.ship` or `audit.queue` is dropped silently, so a misspelt option there keeps its default. A trail that names an unregistered store, or a table that is not migrated, fails where it is written.
- **Hashed values** are comparable across restarts and processes only with `audit.hashKey.secret`.
- **Tables:** one table per trail on every connection. A second trail on the same table is refused; a configured table trail without its own `table` collides with `default`. `audit_outbox` and `audit_seal` are reserved.

## Reading

- Reads apply no authorization scoping.
- Events of one trail on several connections, or from several shipping applications, are not one ordered stream: `seq` orders one table on one connection. An archive's `seq` is arrival order; order it by `at`.
- `at` is the producer's clock (or a value it passed). The trail does not order events by real time across processes.
- `at` keeps milliseconds on every dialect (`DATETIME(3)` on MySQL, `DATETIMEOFFSET(3)` on MSSQL).
- `data` is `LONGTEXT` on MySQL, `TEXT` on Postgres and sqlite, `NVARCHAR(MAX)` on MSSQL; an event shipped through a queue must fit `audit.queue.maxMessageBytes`, or its delivery fails and blocks its trail.

## Shipping

- Delivery is at least once; a destination that does not deduplicate on `id` sees duplicates.
- Reads of a shipping trail lag by at least one shipping interval, longer while a delivery fails.
- The shipper has no dead-letter: an event a sink always refuses blocks its trail on that connection. On the queue, refused messages need a dead-letter queue.
- Whoever can publish `AuditBatchRecorded` to the route can forge archived events.
- A message whose events are more than 5 minutes ahead of the receiving service's clock waits or is dead-lettered.

## Erasure

- A shipping trail without a reader cannot be erased from the shipping application.
- `forget(subject)` on a table trail erases on every connection that holds the trail table, so it fails, with nothing erased, when one connection cannot be looked at, and a failure while erasing leaves the connections after it unerased (those before it stay erased and recorded); `forget(subject, source)` erases on that one connection only.
- One delivery's window: a payload erased while its delivery was under way may sit at the destination until the next shipping run handles those rows.
- Across a queue the erasure boundary is only as exact as the recording applications' clocks; `forget(subject, source)` in a receiving service leaves a window until its next shipping run.
- A blanked payload with its `data_hash` kept and a lawful erasure look alike; only the `erasure` event tells them apart.

## Integrity

- Sealing is keyless: anyone with the application's database credentials can rewrite a trail and its seals together. Keep the logged head hash outside the database and verify with `--head`.
- The unsealed tail, up to about two minutes, is not protected; rows older than the sealing window there read as SUSPECT.
- `audit.seal.settleSeconds` is an insert-to-commit limit. A transaction open longer leaves rows that every later verification lists as not covered by their seal; an inserted row with an earlier `at` looks the same. Both read as SUSPECT (exit code 2), not TAMPERED.
- A tamper report resolves to one seal (`audit.seal.batchSize` events), except for a payload edit, which names the event. Verification stops at the first mismatch.
- `pruned_at` is not hashed: a forged prune of seals older than `retentionDays` passes verification; a younger one reads as SUSPECT, one out of chain order or dated in the future as TAMPERED.
- An erasure record explains a blanked payload only inside a verified seal or in the young unsealed tail, and a forged one that got sealed proves nothing against someone with write access to the trail table.
- Instants are hashed as stored: changing the time zone handling of a connection under sealed data breaks every seal over it.
- Verify assumes the default 60-second period of `audit.seal`; a slower schedule yields false SUSPECT results (a stale tail, erasure records in the tail that stop explaining too early), never a false TAMPERED.
- Switching a trail from `sealed` to `none` and back lets plain retention delete rows inside sealed ranges; verification then reports `count`.
- `verify()` checks one connection per call; `spinajs audit:verify` without `--source` checks every connection that holds the trail table.
