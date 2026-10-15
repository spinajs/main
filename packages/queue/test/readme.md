# Tests

`npm test` needs no broker: the core suites use an in-memory transport and SQLite.

Broker-backed tests live in `packages/queue-stomp-transport/test/integration`. Start ActiveMQ from the
repo root with `docker compose --profile test up -d activemq`. See "Running integration tests" in the
root README.
