# `@spinajs/queue-stomp-transport`

STOMP-over-WebSocket transport for `@spinajs/queue` (tested with ActiveMQ): reconnect, durable subscriptions, retries and dead-letter routing.

## Connection options

| Key | Meaning | Default |
|---|---|---|
| `options.prefetch` | Max unacked messages the broker delivers to this connection (`activemq.prefetchSize`). A worker sets it to its slot count so it never holds more jobs than it can run. Applies to every subscription on the connection, so keep job queues and event topics on separate connections if they need different values. | `1` |
| `retryDelay` | Base delay in ms; retry n waits `retryDelay * 2^(n-1)` | `0` |

Retries: a failed job is retried `RetryCount` times (set on the job), or, when the job has none, `routing.<Job>.maxRetries` times, then moved to its dead-letter channel.

```js
queue: {
  default: 'events',
  connections: [
    { service: 'StompQueueClient', name: 'render-jobs', type: 'job', host: 'ws://broker:61614/ws',
      defaultQueueChannel: '/queue/render', options: { prefetch: 4 } },
    { service: 'StompQueueClient', name: 'events', type: 'event', host: 'ws://broker:61614/ws',
      defaultTopicChannel: '/topic/events' },
  ],
  routing: { RenderJob: { connection: 'render-jobs', channel: '/queue/render', deadLetterChannel: '/queue/render.dlq', maxRetries: 1 } },
}
```
