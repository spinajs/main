# `@spinajs/queue-stomp-transport`

STOMP-over-WebSocket transport for the [`@spinajs/queue`](../queue) module. Publishes and consumes queue messages ( jobs & events ) on a STOMP broker such as ActiveMQ, with broker receipts, reconnect, durable subscriptions, job retries and dead-letter routing.

## Documentation

Full documentation lives in [`docs/queue-stomp-transport`](../../docs/queue-stomp-transport/README.md):

- [STOMP connection](../../docs/queue-stomp-transport/01-stomp-connection.md)
- [Publishing messages](../../docs/queue-stomp-transport/02-publishing-messages.md)
- [Consuming, retries and dead letters](../../docs/queue-stomp-transport/03-consuming-retries-and-dead-letters.md)
- [Credential providers](../../docs/queue-stomp-transport/04-credential-providers.md)
- [Client factory and client id](../../docs/queue-stomp-transport/05-client-factory-and-client-id.md)
- [Extending the STOMP client](../../docs/queue-stomp-transport/06-extending-the-stomp-client.md)

Requires ActiveMQ **Classic** ( tested: 6.1.4 ) with `schedulerSupport="true"`. Without the scheduler, retry
backoff and `ScheduleDelay` are silently ignored. Compose, broker config, replicas, DLQ handling, security and
monitoring: [ACTIVEMQ.md](ACTIVEMQ.md).

```ts
import '@spinajs/queue-stomp-transport';

// config/queue.ts
export default {
  queue: {
    default: 'activemq',
    connections: [
      {
        service: 'StompQueueClient',
        name: 'activemq',
        host: 'ws://localhost:61614/ws',
        defaultQueueChannel: '/queue/default',
        defaultTopicChannel: '/topic/default',
      },
    ],
  },
};
```

## Connection options

| Key | Meaning | Default |
|---|---|---|
| `options.prefetch` | Max unacked messages the broker delivers to this connection (`activemq.prefetchSize`). A worker sets it to its slot count so it never holds more jobs than it can run. Applies to every subscription on the connection, so keep job queues and event topics on separate connections if they need different values. An invalid value (not a positive integer) rejects at `resolve()`. | `1` |
| `retryDelay` | Base delay in ms; retry n waits `retryDelay * 2^(n-1)` | `0` |
| `options.clientIdSuffix` | Appended to the STOMP client-id ( `<clientId>-<suffix>` ). ActiveMQ refuses two connections with one client-id, so every replica needs a stable unique suffix. Falls back to env `QUEUE_INSTANCE_ID`. | unset |
| `clientId` | Base client-id. The DI factory keeps an explicit value, otherwise it uses `<app.name>-<APP_ENV>-<name>`. | derived |
| `options.emitReconnectTimeout` | How long ( ms ) an emit attempt caught by a dropped connection waits for the reconnect. | `60000` |
| `options.receiptTimeout` | How long ( ms ) to wait for the broker RECEIPT of a publish, retry or dead letter. | `5000` |
| `options.emitRetries` | Publish retries ( exponential backoff ) before an emit rejects. | `3` |

Retries: a failed job is retried `RetryCount` times (set on the job), or, when the job has none, `routing.<Job>.maxRetries` times, then moved to its dead-letter channel.

```js
queue: {
  default: 'events',
  connections: [
    { service: 'StompQueueClient', name: 'render-jobs', host: 'ws://broker:61614/ws',
      defaultQueueChannel: '/queue/render', options: { prefetch: 4 } },
    { service: 'StompQueueClient', name: 'events', host: 'ws://broker:61614/ws',
      defaultTopicChannel: '/topic/events' },
  ],
  routing: { RenderJob: { connection: 'render-jobs', channel: '/queue/render', deadLetterChannel: '/queue/render.dlq', maxRetries: 1 } },
}
```

Several message types may share one channel: each consumer only runs its own type.

## Tests

```bash
npm test                      # unit, no broker
npm run test:integration      # needs: docker compose --profile test up -d activemq ( repo root )
```

The integration suite skips itself when no broker answers ( set `QUEUE_IT_REQUIRE_BROKER=1` to fail instead )
and stops / restarts the broker container.
