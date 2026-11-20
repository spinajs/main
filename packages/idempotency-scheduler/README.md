# @spinajs/idempotency-scheduler

Registers the builtin `idempotency.sweep` schedule of `@spinajs/scheduler`. It runs every `idempotency.sweepEvery`
(default `5m`), on the leader only, and deletes expired idempotency replies and abandoned claims batch after batch.
Import it once in the app entry: `import '@spinajs/idempotency-scheduler';`.

See `docs/idempotency-scheduler/README.md`.
