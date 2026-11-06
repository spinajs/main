# @spinajs/idempotency

The idempotency store contract for SpinaJS. `IdempotencyStore` claims a key as a lease fenced by a token, renews the
lease, stores the reply on completion and replays it until its TTL passes. `MemoryIdempotencyStore` keeps the keys in
process memory. `@spinajs/idempotency/testing` exports `describeIdempotencyStoreConformance`, the mocha suite every
store implementation must pass.
