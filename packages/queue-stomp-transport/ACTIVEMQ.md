# Running `@spinajs/queue-stomp-transport` on ActiveMQ

Tested with **ActiveMQ Classic 6.1.4** ( `apache/activemq-classic:6.1.4` ). Artemis is not supported: the
transport uses Classic-only STOMP headers ( `activemq.prefetchSize`, `activemq.subscriptionName`,
`AMQ_SCHEDULED_*` ). The reference broker config is `scripts/docker/activemq/activemq.xml` in the spinajs repo.

## Compose ( single node )

```yaml
services:
  activemq:
    image: apache/activemq-classic:6.1.4
    restart: unless-stopped
    mem_limit: 1536m
    volumes:
      - activemq-data:/opt/apache-activemq/data
      - ./activemq/activemq.xml:/opt/apache-activemq/conf/activemq.xml:ro
      - ./activemq/credentials.properties:/opt/apache-activemq/conf/credentials.properties:ro
    # no `ports:`: only the app reaches the broker, over the compose network
    healthcheck:
      test: ['CMD-SHELL', "bash -c 'exec 3<>/dev/tcp/127.0.0.1/61614' || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 30s

  app:
    environment:
      QUEUE_URL: ws://activemq:61614/ws
      QUEUE_LOGIN: conductor
      QUEUE_PASSWORD_FILE: /run/secrets/queue_password
    depends_on:
      activemq:
        condition: service_healthy

volumes:
  activemq-data:
```

`credentials.properties` ( keep it out of git and mount it from a secret ):

```properties
activemq.username=conductor
activemq.password=<long random>
```

The broker config must keep `schedulerSupport="true"`. Without it, retry backoff and `ScheduleDelay` are
**silently ignored**, and messages arrive immediately. The scheduler store lives under the data volume
( `data/localhost/scheduler` ), so scheduled messages survive a broker restart.

## App config

```js
queue: {
  default: 'jobs',
  connections: [
    { service: 'StompQueueClient', name: 'jobs', type: 'job', host: process.env.QUEUE_URL,
      login: process.env.QUEUE_LOGIN, password: '<from secret>',
      defaultQueueChannel: '/queue/conductor.jobs', defaultQueueDeadLetterChannel: '/queue/conductor.jobs.dlq',
      retryDelay: 5000, options: { prefetch: 4 } },
    { service: 'StompQueueClient', name: 'events', type: 'event', host: process.env.QUEUE_URL,
      login: process.env.QUEUE_LOGIN, password: '<from secret>', defaultTopicChannel: '/topic/conductor.events' },
  ],
  routing: {
    SendNotificationJob: { connection: 'jobs', channel: '/queue/conductor.notifications',
      deadLetterChannel: '/queue/conductor.notifications.dlq', maxRetries: 3 },
  },
}
```

- STOMP `/queue/x` is the ActiveMQ queue named `x`. That is the name the console and Jolokia show.
- Retry n waits `retryDelay * 2^(n-1)` with **no cap**. With `retryDelay: 5000` and `maxRetries: 10`, the last wait is about 43 min.
- Keep jobs and events on separate connections: prefetch applies per connection.
- Several job types may share one channel. Each still only runs its own messages. `stopConsuming()` on a
  shared channel stops every consumer of that channel.

## Replicas

Every connection sends a STOMP `client-id`. ActiveMQ **refuses** a second connection with the same id
( `InvalidClientIDException: ... already connected from ...` ). A replica that collides fails at startup with a
message that names `QUEUE_INSTANCE_ID`.

- Give each replica a **stable**, unique `QUEUE_INSTANCE_ID` ( `worker-1`, `worker-2` ), or set
  `options.clientIdSuffix`. The id is appended to the client-id.
- Keep it stable across restarts. Durable topic subscriptions are keyed by client-id, so a fresh id per
  restart leaves the old subscription collecting messages. The reference config drops subscribers that
  stay offline for 7 days ( `offlineDurableSubscriberTimeout` ).
- Every queue message goes to exactly one replica. A non-durable topic event goes to every connected replica.

## Delivery guarantees ( design jobs for them )

- At-least-once. A job is re-run when its process dies before the ack, or when the app shuts down with jobs
  in flight. Shutdown does not drain. The row is `executing`, which is not terminal, so the job runs again.
  Make jobs idempotent.
- A job whose `queue_jobs` row is terminal ( `success`, `error`, `dead` ) is **skipped** on any later delivery
  of the same `JobId`. "Re-check in 2 minutes" must therefore emit a **new** job ( new `JobId` ) with
  `ScheduleDelay: 120000`. Re-emitting the old `JobId` is a no-op.
- Events are non-persistent by default and are lost while nobody subscribes or the broker restarts. Use a job,
  or a durable subscription, for anything that must not be lost.
- `emit()` resolves when the broker confirms the message ( RECEIPT ). While the broker is unreachable, emits are
  held and sent after the reconnect. A drop mid-publish waits up to `options.emitReconnectTimeout` ( default
  60 s ) per attempt.
- A failed job is acked only after the broker confirmed its retry ( or dead letter ). If that confirmation does
  not arrive within `receiptTimeout`, the original is NACKed instead ( see "Dead letters" ). A late receipt can
  then leave both the retry and the NACKed original in flight, so the job may run once more.

## Memory and disk

- JVM heap: the image default is `-Xmx1G`. Keep the container `mem_limit` at about 1.5x the heap. Check the
  heap with `docker exec <c> ps aux | grep -o 'Xmx[^ ]*'`.
- `memoryUsage percentOfJvmHeap="70"` caps in-memory messages. Beyond it, producer flow control **blocks
  publishers**. Our emits then fail with receipt timeouts after the retries.
- `storeUsage` / `tempUsage` must be below the free space of the `activemq-data` volume. Reaching the store limit
  also blocks producers. Growth comes from unconsumed queues, **dead-letter queues nobody drains**, scheduled
  messages, and orphaned durable subscriptions.

## Dead letters

Messages can end up in two places:

1. **App DLQs**: `deadLetterChannel` / `defaultQueueDeadLetterChannel`. The transport sends a job here after
   its last failed attempt, with headers `x-original-destination`, `x-error` and `x-retry-count`. The row in
   `queue_jobs` is `dead`, and `LastError` holds the message.
2. **Broker DLQs**: `DLQ.<queue>`. The broker routes a message here when the transport NACKs it, which happens
   when a retry or dead-letter publish could not be confirmed.

Inspect ( console at `http://127.0.0.1:8161/admin/queues.jsp`, or Jolokia ):

```bash
J='http://127.0.0.1:8161/api/jolokia'
curl -s -u admin:admin -H 'Origin: http://localhost' \
  "$J/read/org.apache.activemq:type=Broker,brokerName=localhost,destinationType=Queue,destinationName=*/QueueSize"
```

Purge one queue:

```bash
curl -s -u admin:admin -H 'Origin: http://localhost' \
  "$J/exec/org.apache.activemq:type=Broker,brokerName=localhost,destinationType=Queue,destinationName=conductor.jobs.dlq/purge()"
```

**Re-driving a dead job does not work by moving the message back.** Its row is `dead`, so the consumer skips
it, and its `x-retry-count` is already at the limit. Re-run it by emitting a new job with the same payload,
or reset the row ( `Status = 'retrying'`, `Attempt = 0` ) and strip `x-retry-count` before moving it.

## Security

- Never publish the broker ports beyond the host. If the console is needed, publish `8161` on `127.0.0.1`
  only and change the default `admin/admin` in `conf/users.properties` ( 6.1.x web console realm, JAAS ).
- The reference config allows only WebSocket STOMP from outside the container. OpenWire listens on
  `127.0.0.1:61616` inside it, for the bundled CLI tools. Exposed OpenWire on old brokers is the
  CVE-2023-46604 RCE, so stay on 6.1.x or newer.
- Auth is on ( `simpleAuthenticationPlugin`, `anonymousAccessAllowed="false"` ). Use `credentialProvider` in the
  connection options for rotated secrets.
- Use `wss://` if the broker is ever reached across hosts.

## Monitoring hooks

- Connectivity: `node scripts/docker/activemq/stomp-probe.mjs ws://<host>:61614/ws <login> <password>` prints
  `CONNECTED`. In the app, `(queue.get('jobs') as StompQueueClient).Connected` works for a health endpoint.
- Broker gauges ( Jolokia `read` on `org.apache.activemq:type=Broker,brokerName=localhost` ): `StorePercentUsage`,
  `MemoryPercentUsage`, `TempPercentUsage`. Alert above 70 %.
- Per queue: `QueueSize`, `ConsumerCount`, `EnqueueCount`, `DequeueCount`. Alert when any `*.dlq` or `DLQ.*`
  `QueueSize` is > 0, or when a job queue has `ConsumerCount == 0`.
- App side: `SELECT Status, COUNT(*) FROM queue_jobs GROUP BY Status`. Alert on `dead` growth, and on
  `executing` / `retrying` rows older than the longest job. Log lines worth alerting on: `routed to dead-letter`,
  `nacking instead`, `Websocket error`, `not connected, message ... buffered`, `Cannot ack`.
