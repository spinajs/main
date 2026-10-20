# `@spinajs/queue`

Typed queue events and jobs for SpinaJS: emit and consume through pluggable `QueueClient` transports, route by config, and track jobs in the `queue_jobs` table with retries, progress, deduplication and retention. Install a transport package (`@spinajs/queue-stomp-transport`, `@spinajs/queue-amqp-transport`, `@spinajs/queue-sqs-transport`) for a real broker.

## Documentation

- [Package overview](../../docs/queue/README.md)
- [Events and jobs](../../docs/queue/01-events-and-jobs.md)
- [Connections and routing](../../docs/queue/02-connections-and-routing.md)
- [Job tracking](../../docs/queue/03-job-tracking.md)
- [Transports (`QueueClient`)](../../docs/queue/04-transports.md)
- [Credential providers](../../docs/queue/05-credential-providers.md)
- [Message hooks](../../docs/queue/06-message-hooks.md)
- [Tracking hooks](../../docs/queue/07-tracking-hooks.md)
- [Job retention](../../docs/queue/08-job-retention.md)
- [Replacing or extending `QueueService`](../../docs/queue/09-queue-service.md)
