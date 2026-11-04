# @spinajs/idempotency

One idempotency service for SpinaJS: a call runs at most once per key while its reply is kept, a repeat replays the
reply, and a claim whose replica died is taken over when its lease ends. Used by `@spinajs/http` (`@Idempotent()`),
`@spinajs/http-socket` (idempotent commands) and `@spinajs/queue` (event deduplication).

See `docs/idempotency/README.md`.
