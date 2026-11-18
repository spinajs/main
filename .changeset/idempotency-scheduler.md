---
"@spinajs/idempotency-scheduler": minor
---

New package: the builtin `idempotency.sweep` schedule of `@spinajs/scheduler`. Import it once in the app entry. It runs every `idempotency.sweepEvery` (default `5m`) on the leader, skips overlapping runs, and deletes expired idempotency replies and abandoned claims batch after batch until a batch comes back empty. Each run stores `{ swept, batches }` as its result and logs one line. It is listed, run, paused and read with the scheduler's CLI and HTTP API like any schedule; a `scheduler.schedules` entry named `idempotency.sweep` retimes it or switches it off (`enabled: false`).
