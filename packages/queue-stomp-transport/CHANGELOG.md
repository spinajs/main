# Changelog

## Unreleased

### Fixed
- Several message types on one channel: every consumer receives the message. Before, the second `consume()` was
  ignored and its messages were acked unprocessed by the first consumer's name filter.
- A failed job's retry or dead-letter republish now waits for the broker RECEIPT before the original is acked.
  If the receipt never comes, the original is NACKed instead of being acked and lost.
- An ack or nack that fails because the socket is gone is logged instead of escaping as an unhandled rejection,
  and an ack lost after a successful run no longer sends the job down the retry path.
- An emit whose publish is caught by a connection drop waits for the reconnect ( `options.emitReconnectTimeout` )
  instead of failing within milliseconds. `whenReady()` rejects on `dispose()`.
- The DI factory keeps an explicit `clientId`.

### Added
- `options.clientIdSuffix` / env `QUEUE_INSTANCE_ID`: per-replica client-id suffix. A duplicate client-id
  refusal now says how to fix it.
- Broker-gated integration suite ( `npm run test:integration` ) against ActiveMQ Classic 6.1, and `ACTIVEMQ.md`
  ops notes.

### Changed
- `npm test` runs unit tests only. The live-broker suite moved to `test/integration`.
- `publishWithReceipt()` ( protected ) takes a log label instead of the message as its 4th argument.
