---
"@spinajs/durable": minor
"@spinajs/scheduler": minor
---

New package `@spinajs/durable`, the durability kernel: `Clock`, `DurableSystemClock`, `DbClock`, `DbTimeSource`, `parseDuration`, `computeBackoff`, `isRetryable`, `NonRetryableError`, `Heartbeat` and `buildReplayMap` move here from `@spinajs/scheduler`, joined by the fenced row lease `RowLease` and the no-op `FaultInjector` seam. `@spinajs/durable/testing` ships `FakeClock` and `FakeDbTimeSource`. The scheduler re-exports every moved symbol under its old name (`SchedulerSystemClock` is an alias of `DurableSystemClock`); its behaviour does not change, except that `dbNowSql` is removed: `SqlDbTimeSource` reads the time through the driver's `SqlExpressions.epochMillis()`, which also makes it work on PGlite and on drivers registered under another name.

`@spinajs/scheduler` no longer exports `journalPositionSql`; the journal and the failure counters write through the query builder (`increment()`), and the journal serializes appends in memory on any driver without concurrent transactions (sqlite, PGlite).
