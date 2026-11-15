# `@spinajs/durable`

The durability kernel shared by the scheduler, workflows and the queue outbox relay: `Clock`, `DbClock` and `DbTimeSource`, `parseDuration`, retry backoff (`computeBackoff`, `isRetryable`, `NonRetryableError`), `Heartbeat`, step replay (`buildReplayMap`), the fenced row lease `RowLease` and the `FaultInjector` seam. `@spinajs/durable/testing` ships `FakeClock` and `FakeDbTimeSource`.

```ts
import { DbClock, RowLease } from '@spinajs/durable';

const lease = new RowLease(driver);
const claim = await lease.claim({ table: 'jobs', key: { Id: 'job-1' } }, 'replica-a', 60_000, await dbClock.sync());
```

Details: [docs/durable](../../docs/durable/README.md).
