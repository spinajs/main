# @spinajs/idempotency

One idempotency service for SpinaJS: a call runs at most once per key while its reply is kept, a repeat replays the
reply, and a claim whose replica died is taken over when its lease ends. `IdempotencyService.run(scope, key, fn, opts)`
claims the key as a lease fenced by a token, renews it while `fn` runs, and stores the reply or releases the key.

`OrmIdempotencyStore` (the default) keeps the keys in the `__idempotency` table on the connection alias `idempotency`
(`db.Aliases.idempotency`, `default` unless the app maps it elsewhere); import `@spinajs/idempotency` in the app entry
before the boot, so the Orm sees its model and migration. `MemoryIdempotencyStore` keeps them in process memory.

`@spinajs/idempotency/testing` exports `describeIdempotencyStoreConformance`, the mocha suite every store
implementation must pass.

See `docs/idempotency/README.md`.
