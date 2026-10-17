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

## Usage

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
