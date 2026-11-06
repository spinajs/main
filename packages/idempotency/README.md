# @spinajs/idempotency

The idempotency store contract for SpinaJS. `IdempotencyStore` claims a key as a lease fenced by a token, renews the
lease, stores the reply on completion and replays it until its TTL passes. `MemoryIdempotencyStore` keeps the keys in
process memory. `OrmIdempotencyStore` keeps them in the `__idempotency` table on the connection alias `idempotency`
(`db.Aliases.idempotency`, `default` unless the app maps it elsewhere); import `@spinajs/idempotency` in the app entry
before the boot, so the Orm sees its model and migration.

`IdempotencyLeases` turns a claim into an `IdempotencyHandle`: it renews the lease every third of its length until the
handle completes, releases or abandons the key, and aborts `handle.signal` with `IdempotencyLeaseLost` once a renewal
is refused.

`@spinajs/idempotency/testing` exports `describeIdempotencyStoreConformance`, the mocha suite every store
implementation must pass.
