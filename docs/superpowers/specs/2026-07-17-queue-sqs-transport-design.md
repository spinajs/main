# SQS transport for `@spinajs/queue` + consumer-side job tracking

**Date:** 2026-07-17
**Packages:** `queue` (core change), `queue-sqs-transport` (new)
**Branch:** `feat/queue-sqs-transport` (Spinajs monorepo)

## Problem

`@spinajs/queue` supports two broker transports (AMQP 0-9-1, STOMP) and a dead
ORM transport. There is no AWS-native transport. Amazon SQS is the natural
managed queue in AWS — no broker to run, native at-least-once delivery, native
retry (visibility timeout) and dead-letter (redrive policy). We want SQS as a
first-class `@spinajs/queue` transport so a worker can `consume(SomeJob)` from
SQS with full job semantics, and a producer can `emit` to it — including a
producer that is not even a Spinajs process (Step Functions' native
`sqs:sendMessage`, building the JSON envelope itself).

A structural obstacle sits in the way. The core `DefaultQueueService` couples
job emission to a **database write**: `emit()` inserts a `queue_jobs` tracking
row (stamping `JobId`) before publishing, and `consume()` does
`JobModel.where({JobId}).firstOrThrow()` — it requires the producer to have
written that row. That forces every producer to have ORM + DB access, which is
exactly what a thin/native SQS producer must avoid.

## Goals

- A `@spinajs/queue-sqs-transport` package implementing the `QueueClient`
  contract over Amazon SQS: `emit` publishes the JSON envelope; `subscribe`
  long-polls and acks by deleting, nacks by letting the message reappear (native
  redelivery → DLQ). No DB code in the transport.
- Decouple the producer from the database: **the producer only generates a
  `JobId`; the consumer writes the tracking row** (insert-or-update). This makes
  every transport's producer DB-free and enables Step-Functions-native SQS
  production.
- Preserve full `QueueJob` semantics — `execute()`, `Status`, `Attempt`,
  `Progress`, `Result` — on the consumer side, unchanged from today.
- No regression for AMQP/STOMP.

## Non-goals

- **The `sn-step-schedules` integration** (SQS queue + DLQ in SAM, Step Functions
  `sqs:sendMessage`, the mailer worker consumer). Separate follow-up once the
  transport exists.
- **A Spinajs producer for SQS.** The SQS producer will be Step Functions native
  `sqs:sendMessage`; this spec provides the transport (needed for the consumer,
  and usable by a Spinajs producer too) but does not build a producer app.
- **FIFO / exactly-once.** Standard queue + at-least-once + idempotent handlers.
  FIFO is a future option (noted where relevant), not built here.
- **Changing `IQueueConnectionOptions`.** SQS-specific settings ride the existing
  free-form `options` passthrough.

## Design

### Part A — core change: producer generates `JobId`, consumer writes the row

Two edits in `packages/queue/src/index.ts` (`DefaultQueueService`), verified
against the current code:

**`emit` (currently `:47-57`)** — replace the insert with id generation:

```ts
if (isJob(event)) {
  event.JobId = event.JobId ?? uuidv4();   // generate only; DO NOT insert
}
await connection.emit(event);
```

The producer no longer touches the DB. (`event.JobId ??` lets a producer that
already set a JobId — e.g. Step Functions via `States.UUID()` in the envelope —
keep it; otherwise generate one.)

**`consume` (currently `:121-166`)** — replace `firstOrThrow` with find-or-create,
preserving every status/attempt/progress update:

```ts
if (ev instanceof QueueJob) {
  // Consumer owns the tracking row now. First receipt inserts; a redelivery
  // (SQS visibility timeout / failure, or STOMP/AMQP requeue) finds the row
  // from the prior attempt and updates it. The queue_jobs.JobId unique index
  // makes a rare concurrent double-receipt safe: the second insert collides and
  // is resolved by re-reading.
  let jModel = await JobModel.where({ JobId: ev.JobId }).first();
  const firstReceipt = !jModel;
  if (!jModel) {
    jModel = new JobModel();
    jModel.JobId = ev.JobId;
    jModel.Name = ev.Name;
    jModel.Connection = /* the connection name this was consumed on */;
    jModel.Attempt = 0;
    jModel.Progress = 0;
  }
  jModel.Status = 'executing';
  jModel.ExecutedAt = DateTime.now();

  try {
    await persist(jModel, firstReceipt);   // insert-or-update; see below
    jobResult = await ev.execute(onProgress);
    jModel.Result = jobResult; jModel.Status = 'success';
    jModel.FinishedAt = DateTime.now(); jModel.Progress = 100;
  } catch (err) {
    jModel.Attempt = (jModel.Attempt ?? 0) + 1;
    const maxRetries = ev.RetryCount ?? 0;
    jModel.Status = jModel.Attempt > maxRetries ? 'dead' : 'retrying';
    jModel.Result = { message: err.message };
    await jModel.update();
    throw err;   // re-throw so the transport nacks (SQS: leave it; visibility → redeliver → DLQ)
  }
  await jModel.update();
}
```

`persist(jModel, firstReceipt)`:
- If `firstReceipt` and the model has no PK → `jModel.insert()`. On a unique-key
  collision (concurrent double-receipt), catch it, re-read
  `JobModel.where({JobId}).firstOrThrow()`, and continue as a redelivery.
- Else → `jModel.update()`.
- Equivalently, `jModel.insert(InsertBehaviour.InsertOrUpdate)` (compiles to
  `ON DUPLICATE KEY UPDATE` on the `JobId` unique index) is the atomic
  single-statement form — the plan picks whichever reads cleanest and is proven by
  test. The observable contract is: **first receipt creates a `queue_jobs` row;
  redelivery updates it; `Attempt` reflects failed runs.**

**Behavior changes to accept (documented, tested):**

1. **A queued-but-unstarted job has no `queue_jobs` row** until a consumer picks
   it up (previously the producer created a `created` row at emit time). For SQS
   the "queued" state is observable via SQS metrics
   (`ApproximateNumberOfMessages`). The `created` status effectively disappears —
   a job goes straight to `executing` on first receipt. **Decision to confirm at
   review:** drop `created`, or have the consumer write a transient `created`
   immediately before `executing` (adds a write for little value). Default: drop
   it; a job's first observable DB state is `executing`.
2. **`queue-http-progress`** serves status from `JobModel.Status`; a not-yet-picked
   job now returns no row. It needs a "missing row ⇒ queued/unknown" convention.
   The plan checks whether `queue-http-progress` needs a matching tweak or a doc note.
3. This is a **cross-transport** change: AMQP and STOMP producers also stop writing
   the row, and their consumers now create it. The existing AMQP/STOMP integration
   tests must still pass (a job emitted then consumed still ends `success` with a
   correct row) — this is the primary regression gate.

### Part B — the `queue-sqs-transport` package

Mirror `queue-amqp-transport`'s skeleton (`index.ts` barrel, `connection.ts`,
`connection-factory.ts`, three tsconfigs, `.mocharc.json`). No `migrations`/`models`
(the transport carries no DB concern — that's core, consumer-side).

`SqsQueueClient extends QueueClient`, `@PerInstanceCheck()` + `@Injectable(QueueClient)`.
Config connection: `{ service: 'SqsQueueClient', name, options: { region, queueUrl,
waitTimeSeconds?, visibilityTimeout?, maxMessages?, endpoint?, credentials? } }` —
SQS settings ride `options` (no core interface change). Dep: `@aws-sdk/client-sqs`
plus the five standard `@spinajs/*`.

**Abstract methods to implement:**

- `resolve()` — construct the `SQSClient` from `options` (region/endpoint/credentials).
  No eager connection (SQS is HTTP; nothing to open). Validate `queueUrl` present.
- `emit(message)` — `JSON.stringify(message)` (envelope: `Name`, `Type`, `CreatedAt`
  ISO, `JobId`, `RetryCount`, `Persistent`, `Priority`, + payload) → `SendMessageCommand`
  to the destination queue URL. Destination from `getChannelForMessage(message)`
  (inherited) — for SQS the "channel" is a queue URL; routing maps `message.Name` →
  queue URL, falling back to `defaultQueueChannel`. `Name`/`Type` live in the body
  (that is what the core rehydration reads); optionally mirrored into
  `MessageAttributes` for observability only.
- `subscribe(eventOrChannel, callback, subscriptionId?, durable?)` — resolve the
  queue URL (via `getChannelForMessage` for a message class, or the string channel),
  register a descriptor in an internal `Map`, and start a **detached long-poll loop**:
  `ReceiveMessageCommand({ QueueUrl, WaitTimeSeconds: waitTimeSeconds ?? 20,
  MaxNumberOfMessages: maxMessages ?? 1, VisibilityTimeout: visibilityTimeout })`.
  For each message: `JSON.parse(Body)`, rehydrate `CreatedAt` (ISO → Luxon
  `DateTime`, mirroring STOMP), then `callback(parsed).then(deleteMessage).catch(leave)`:
  - success → `DeleteMessageCommand({ QueueUrl, ReceiptHandle })` (ack).
  - failure → do nothing; the message reappears after `VisibilityTimeout` (nack),
    and SQS's redrive policy moves it to the DLQ after `maxReceiveCount`. No manual
    retry/dead-letter logic — SQS owns it. (Optionally `ChangeMessageVisibility` for
    backoff; not required.)
  Loop honors a per-descriptor `running` flag / `AbortController`.
- `unsubscribe(eventOrChannel, removeDurable?)` — flip the descriptor's `running`
  off / abort the in-flight `ReceiveMessage`, delete the descriptor.
- `dispose()` — stop all loops, `SQSClient.destroy()`.

**Long-running vs Lambda:** the consumer is a long-lived worker (the loop runs until
`unsubscribe`/`dispose`). The transport is not intended for a short-lived producer;
SQS production from Lambda/Step Functions is a plain `SendMessage`, not this loop.

## Error handling

- Transport `emit` failures (SQS unreachable, bad queue URL) reject — the producer
  sees the error. Core `emit` no longer has a DB failure mode (no insert).
- Consumer handler throw → core re-throws → transport leaves the message → SQS
  redelivers → DLQ after `maxReceiveCount`. The `queue_jobs` row records
  `Attempt`/`retrying`/`dead` on each failed receipt (Part A).
- A `ReceiveMessage` transient error in the poll loop is logged and the loop
  continues (a poison receive must not kill the worker). Backoff on repeated errors.
- Concurrent double-receipt on first insert → unique-key collision → re-read and
  proceed (Part A `persist`).

## Testing

- **Core (`queue`) — the regression gate.** Unit-test `emit` no longer inserts
  (mock/stub the connection + assert no `JobModel.insert`), and `consume` find-or-create
  (first receipt inserts row `executing`; simulated redelivery updates `Attempt`;
  handler throw sets `retrying`/`dead` by `RetryCount`). The existing AMQP and STOMP
  integration suites (docker brokers) must still pass end-to-end — a job emitted then
  consumed ends `success` with a correct row, now created consumer-side.
- **`queue-sqs-transport`.** Against **localstack SQS** (docker) or
  `aws-sdk-client-mock`: `emit` puts a message whose body has `Name`/`Type:"JOB"`/`JobId`;
  `subscribe` receives it, invokes the callback, deletes on success; on handler throw
  the message is NOT deleted and reappears after the visibility timeout; `dispose`
  stops the loop and the process exits cleanly. One end-to-end test: emit via
  `QueueService` over SQS, consume via `QueueService` over SQS, assert the `queue_jobs`
  row is created consumer-side and the job runs `execute()`.
- **Baseline-diff** every touched package (`queue`, and AMQP/STOMP suites); this repo
  carries pre-existing failures — matching the baseline is success.

## Consequences / follow-ups

- Enables a **DB-free producer for every transport**, and specifically the
  `sn-step-schedules` design: Step Functions builds the envelope (`Name:"SendEmailJob"`,
  `Type:"JOB"`, `JobId` via `States.UUID()`, `CreatedAt`, payload) and `sqs:sendMessage`s
  it — no producer Lambda — and the mailer worker consumes via this transport, rendering
  the S3 MJML template (the `fs-s3`/templates work already done) and sending over SMTP.
  That integration is the next project.
- `queue-orm-transport` (dead code) is untouched; this does not revive it.
