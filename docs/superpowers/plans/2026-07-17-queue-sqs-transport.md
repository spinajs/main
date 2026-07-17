# SQS transport + consumer-side job tracking — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@spinajs/queue` producers DB-free (producer generates `JobId`; consumer writes the `queue_jobs` row via insert-or-update), then add `@spinajs/queue-sqs-transport` — a `QueueClient` over Amazon SQS.

**Architecture:** Two pieces. (A) A core change in `DefaultQueueService`: `emit` stops inserting the tracking row and only stamps a `JobId`; `consume` does find-or-create on first receipt / update on redelivery, preserving all `QueueJob` semantics. (B) A new transport package mirroring `queue-amqp-transport`: `emit` sends a JSON envelope to SQS; `subscribe` long-polls, acks by `DeleteMessage`, nacks by leaving the message (SQS visibility timeout redelivers → DLQ). No DB code in the transport.

**Tech Stack:** TypeScript (ESM, `node16`), lerna monorepo with tsc project references, ts-mocha + chai, `@aws-sdk/client-sqs`, localstack (docker) for SQS tests, ActiveMQ (docker) for the STOMP regression gate.

**Spec:** `docs/superpowers/specs/2026-07-17-queue-sqs-transport-design.md` (read it).

## Global Constraints

- **No AMQP/STOMP regression.** The core change is cross-transport. The existing `queue/test/jobs.test.ts` (docker ActiveMQ) end-to-end job flow must still pass: a job emitted then consumed ends `success` with a correct `queue_jobs` row — now created consumer-side. This is the primary gate.
- **Absolute green is NOT the signal — this repo has ~34 pre-existing failures.** Baseline-diff every touched package; matching the baseline is success. Establish each baseline before changing it.
- **Full `QueueJob` semantics preserved consumer-side**: `execute()`, `Status` (`executing`→`success`|`retrying`|`dead`), `Attempt`, `Progress`, `Result`. The only removed state is the producer-time `created` (a job's first observable DB state becomes `executing`).
- **No change to `IQueueConnectionOptions`.** SQS settings ride the free-form `options` passthrough.
- **`JobId` is unique** (`queue_jobs` unique index). Consumer insert must tolerate a concurrent double-receipt (unique-key collision → re-read).
- **Package versions:** internal `@spinajs/*` deps pinned to `2.0.481`. New package is `@spinajs/queue-sqs-transport@2.0.481`.
- **`npm run build` ALONE leaves a package broken** (`clean` rimrafs both `lib/mjs` and `lib/cjs`; `compile` only rebuilds mjs). Always `npm run build && npm run compile:cjs`. Never run the root `npm run build`. Workspace `@spinajs/*` resolve to compiled `lib/` — rebuild `queue` after changing it or downstream tests use stale code.
- **Commit style:** conventional commits. **Branch:** `feat/queue-sqs-transport`. Do not merge/push.
- Bash expands `test/**/*.test.ts` to a silent zero-test run — prefer PowerShell or verify the count is non-zero.

## Key code facts (verified)

- Producer insert: `queue/src/index.ts:47-60` (`if (isJob(event)) { new JobModel(); … insert(); event.JobId = … }`).
- Consumer lookup: `queue/src/index.ts:121-166` (`if (ev instanceof QueueJob) { … firstOrThrow … execute … }`); the connection name `c` is in scope (the `for (let c of connections)` at `:103`).
- `BlackHoleQueueClient` (`queue/src/BlackHoleQueueClient.ts`) — a no-op transport usable to unit-test the core without a broker.
- `queue/test/jobs.test.ts` uses docker ActiveMQ (there's a `Dockerfile` + `activemq.xml` in `queue/test/`). The STOMP transport is what it drives.
- ORM upsert: `model.insert(InsertBehaviour.InsertOrUpdate)` → `ON DUPLICATE KEY UPDATE`; model-level `insertOrUpdate()` chooses insert/update by PK presence (`orm/src/model.ts:546-596`).
- `queue-http-progress` reads `JobModel.select().where('JobId', jobId).firstOrFail()` (`controllers/JobsControllers.ts:10`) — a missing row throws today.
- Transport skeleton to mirror: `queue-amqp-transport/{package.json,tsconfig*.json,.mocharc.json,src/{index,connection,connection-factory}.ts}`. Deps: 5× `@spinajs/*@^2.0.481` + the broker lib.

---

### Task 1: Core — producer generates `JobId`, consumer find-or-create (unit-tested, no broker)

**Files:**
- Modify: `packages/queue/src/index.ts` (`emit` :47-60, `consume` :121-166)
- Create: `packages/queue/test/tracking.test.ts` (unit, uses `BlackHoleQueueClient` + in-memory sqlite `JobModel`)

**Interfaces:**
- Produces: `emit` no longer writes `queue_jobs`; `consume` writes it (insert on first receipt, update on redelivery), preserving Status/Attempt/Progress/Result.

- [ ] **Step 1: Establish the queue baseline**

`cd packages/queue && npm test`. Record pass/fail. `jobs.test.ts` needs docker ActiveMQ — if docker isn't up for this task, note which tests are broker-gated; the unit test below does not need a broker.

- [ ] **Step 2: Write the failing unit test**

`packages/queue/test/tracking.test.ts` — drive `QueueService.emit`/`consume` with `BlackHoleQueueClient` (no network) and an in-memory sqlite `queue` connection so `JobModel` reads/writes work. Read `queue/test/jobs.test.ts` for the config/bootstrap idiom (Configuration subclass, `DI.resolve(Orm)` to migrate `queue_jobs`, `DI.resolve(QueueService)`), then:

```ts
// A @Job() class whose execute() we control.
@Job()
class TrackedJob extends QueueJob {
  public ShouldFail = false;
  public async execute() { if (this.ShouldFail) throw new Error('boom'); return 'ok'; }
}

it('emit does not write a queue_jobs row (producer is DB-free)', async () => {
  const before = (await JobModel.all()).length;
  await TrackedJob.emit({});
  assert.equal((await JobModel.all()).length, before); // no row at emit time
});

it('consume creates the row on first receipt and runs execute()', async () => {
  // manually drive a receipt: build the wire message and invoke the consume path.
  // Easiest: emit through BlackHole (captures the message), then feed it to the
  // registered subscribe callback. Or call QueueService.consume(TrackedJob, cb) and
  // have the BlackHole transport deliver the emitted message to the callback.
  // Assert: a queue_jobs row now exists with Name='TrackedJob', Status='success'.
});

it('a redelivery updates the existing row and bumps Attempt on failure', async () => {
  // deliver the same JobId twice with ShouldFail=true; assert one row, Attempt=2,
  // Status='retrying' or 'dead' per RetryCount — NOT two rows.
});
```

The mechanism to "deliver a message to the consume callback" depends on how `BlackHoleQueueClient.subscribe` works — **read it first** (`queue/src/BlackHoleQueueClient.ts`). If it doesn't loop messages back, add a tiny test-local `QueueClient` stub whose `emit` stashes messages and whose `subscribe` replays them to the callback, registered as the `queue` connection. That stub is the cleanest way to exercise `consume` deterministically without a broker.

- [ ] **Step 3: Run — fails**

`cd packages/queue && npx ts-mocha -p tsconfig.json test/tracking.test.ts` → the "emit does not write a row" test FAILS (today emit inserts).

- [ ] **Step 4: Implement the core change**

`emit` (`index.ts:47-60`) — replace the insert block with:

```ts
if (isJob(event)) {
  event.JobId = event.JobId ?? uuidv4();   // generate only; consumer writes the row
}
```

`consume`'s `if (ev instanceof QueueJob)` block (`index.ts:121-166`) — replace `firstOrThrow` with find-or-create and wrap the initial insert to tolerate a unique-key race. Preserve every Status/Attempt/Progress/Result line:

```ts
if (ev instanceof QueueJob) {
  let jobResult = null;

  // Consumer owns the tracking row. First receipt inserts; a redelivery finds the
  // row from the prior attempt. The queue_jobs.JobId unique index makes a rare
  // concurrent double-receipt safe (second insert collides -> re-read).
  let jModel = await JobModel.where({ JobId: ev.JobId }).first();
  if (!jModel) {
    jModel = new JobModel();
    jModel.JobId = ev.JobId;
    jModel.Name = ev.Name;
    jModel.Connection = c;
    jModel.Attempt = 0;
    jModel.Progress = 0;
    try {
      await jModel.insert();
    } catch (e) {
      // concurrent first-receipt from another worker won the insert; re-read and continue.
      jModel = await JobModel.where({ JobId: ev.JobId }).firstOrThrow(new UnexpectedServerError(`No model found for jobId ${ev.JobId}`));
    }
  }

  jModel.Status = 'executing';
  jModel.ExecutedAt = DateTime.now();

  try {
    await jModel.update();
    jobResult = await ev.execute(onProgress);
    jModel.Result = jobResult;
    jModel.Status = 'success';
    jModel.FinishedAt = DateTime.now();
    jModel.Progress = 100;
    this.Log.trace(`Job ${event.name} processed with result ${JSON.stringify(jModel.Result)}`);
  } catch (err) {
    this.Log.error(err, `Cannot execute job ${event.name}`);
    jModel.Attempt = (jModel.Attempt ?? 0) + 1;
    const maxRetries = (ev as QueueJob).RetryCount ?? 0;
    jModel.Status = jModel.Attempt > maxRetries ? 'dead' : 'retrying';
    jModel.Result = { message: err.message };
    await jModel.update();
    throw err;
  }

  await jModel.update();

  async function onProgress(p: number) {
    jModel.Progress = p;
    await jModel.update();
    self.Log.trace(`Job ${event.name}:${jModel.JobId} progress: ${p}%`);
  }
}
```

Confirm `uuidv4`, `JobModel`, `InsertBehaviour`/`first`/`firstOrThrow`, `UnexpectedServerError` are already imported in this file (the old code used `uuidv4`, `JobModel`, `firstOrThrow`, `UnexpectedServerError`); only `.first()` may be new — verify it exists on the query builder (it does; `firstOrThrow` is `first` + throw).

- [ ] **Step 5: Run unit test — passes; prove it discriminates**

`npx ts-mocha -p tsconfig.json test/tracking.test.ts` → PASS. Then temporarily revert the `emit` change and confirm the "does not write a row" test FAILS; revert back. Report both observations.

- [ ] **Step 6: Rebuild + commit**

```bash
cd packages/queue && npm run build && npm run compile:cjs
cd ../..
git add packages/queue/src/index.ts packages/queue/test/tracking.test.ts
git commit -m "feat(queue): move job tracking-row write from producer to consumer

emit() now only stamps a JobId; the consumer inserts the queue_jobs row on
first receipt and updates it on redelivery (insert-or-update, tolerating the
JobId unique-key race). This frees every transport's producer from the DB
and enables a native/Step-Functions SQS producer. Full QueueJob semantics
(execute/Status/Attempt/Progress/Result) are preserved consumer-side; only
the producer-time 'created' state is gone."
```

---

### Task 2: Core regression gate — AMQP/STOMP still work end-to-end

**Files:** none (verification). Needs docker.

- [ ] **Step 1: Run the STOMP job flow against ActiveMQ**

Build the broker and run the existing suite:

```bash
cd packages/queue/test && docker build -t spinajs-activemq . && docker run -d --name q-activemq -p 61614:61614 -p 8161:8161 spinajs-activemq
cd .. && npm test   # jobs.test.ts drives STOMP end-to-end
docker rm -f q-activemq
```

Expected: `jobs.test.ts` passes — a job emitted then consumed ends `success`, with the `queue_jobs` row now created consumer-side. **If a test asserted the row exists right after emit (producer-side), it will fail — that is the intended behavior change; update that assertion to check post-consume, and note it. Do NOT weaken it to assert nothing.**

- [ ] **Step 2: STOMP transport suite**

`cd packages/queue-stomp-transport && npm test` (its `stomp-transport.test.ts` needs the broker; `stomp-transport.unit.test.ts` does not). Baseline-diff. Expected: no new failures attributable to the core change.

- [ ] **Step 3: AMQP transport suite (if a broker is available)**

`queue-amqp-transport` tests need RabbitMQ. If no RabbitMQ is available, **report it as unverified** rather than skipping silently — the AMQP consumer path shares the changed core `consume`, so it should be exercised. A local RabbitMQ: `docker run -d --name q-rabbit -p 5672:5672 rabbitmq:3`.

- [ ] **Step 4: Report**

Table: package | baseline | now | verdict. State explicitly whether the ActiveMQ end-to-end job flow passed with consumer-side insert, and any assertion you had to update for the behavior change.

---

### Task 3: `queue-http-progress` — tolerate a missing row (queued state)

**Files:**
- Modify: `packages/queue-http-progress/src/controllers/JobsControllers.ts`

**Interfaces:**
- Consumes: the Task 1 behavior (a queued-but-unstarted job has no row).

- [ ] **Step 1: The change**

`getStatus` does `JobModel.select().where('JobId', jobId).firstOrFail()` — which now throws for a job still sitting in the queue. Change it to return gracefully: use `.first()` and, when absent, respond with a `queued`/`unknown` status rather than a 500.

```ts
const row = await JobModel.select().where('JobId', jobId).first();
if (!row) {
  return new Ok({ jobId, status: 'queued', progress: 0, message: undefined, createdAt: undefined });
}
// ... existing mapping ...
```

Verify `IJobStatusResponse` (`models/JobEntry.ts`) permits this shape — `status` is `JobModel['Status']`, which does NOT include `'queued'`. Widen the response type to `JobModel['Status'] | 'queued'`, or return `'unknown'` if you prefer not to introduce a new literal. Pick one and keep it consistent; note the choice.

- [ ] **Step 2: Build + commit**

```bash
cd packages/queue-http-progress && npm run build && npm run compile:cjs
cd ../..
git add packages/queue-http-progress/src
git commit -m "fix(queue-http-progress): report queued for jobs without a tracking row

Job rows are now written consumer-side, so a job still in the queue has no
row. getStatus returns a 'queued' status instead of throwing firstOrFail."
```

---

### Task 4: `queue-sqs-transport` — package scaffold + `SqsQueueClient` skeleton

**Files:**
- Create: `packages/queue-sqs-transport/{package.json, .mocharc.json, tsconfig.json, tsconfig.mjs.json, tsconfig.cjs.json, typedoc.json, .eslintrc.cjs}`
- Create: `packages/queue-sqs-transport/src/{index.ts, connection.ts, connection-factory.ts}`

**Interfaces:**
- Produces: an installable, compiling `@spinajs/queue-sqs-transport` exporting `SqsQueueClient` (methods stubbed/throwing) + its factory.

- [ ] **Step 1: Mirror the package skeleton**

Copy `queue-amqp-transport`'s config files, changing name to `@spinajs/queue-sqs-transport`, description, and deps: replace `amqplib`/`@types/amqplib` with `@aws-sdk/client-sqs` (`^3.700.0`); keep the five `@spinajs/*@^2.0.481` + `@types/luxon`/`@types/node`. Match the tsconfig `references` (configuration, di, exceptions, log, queue) in all three tsconfigs. Add the package to the root workspace if the monorepo lists packages explicitly (check root `package.json`/`lerna.json` — the `packages/*` glob likely covers it automatically).

- [ ] **Step 2: `connection.ts` skeleton**

```ts
import { QueueClient, IQueueMessage, QueueMessage } from '@spinajs/queue';
import { Injectable, PerInstanceCheck, Constructor } from '@spinajs/di';
import { IQueueConnectionOptions } from '@spinajs/queue';

export interface ISqsConnectionOptions {
  region?: string; queueUrl?: string; endpoint?: string;
  waitTimeSeconds?: number; visibilityTimeout?: number; maxMessages?: number;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

@PerInstanceCheck()
@Injectable(QueueClient)
export class SqsQueueClient extends QueueClient {
  public async resolve(): Promise<void> { throw new Error('not implemented'); }
  public async emit(_message: IQueueMessage): Promise<void> { throw new Error('not implemented'); }
  public async subscribe(_e: any, _cb: (e: IQueueMessage) => Promise<void>, _sid?: string, _durable?: boolean): Promise<void> { throw new Error('not implemented'); }
  public unsubscribe(_e: any, _removeDurable?: boolean): void { throw new Error('not implemented'); }
  public async dispose(): Promise<void> { /* stub */ }
}
```

Verify the exact `QueueClient` abstract signatures against `queue/src/interfaces.ts` (the `subscribe`/`unsubscribe` overloads) and match them precisely, or TS won't accept the subclass.

- [ ] **Step 3: `connection-factory.ts` + `index.ts`**

Mirror `queue-amqp-transport/src/connection-factory.ts` (register a factory that news up `SqsQueueClient` with `{...options, clientId}` and calls `await c.resolve()`, `.as(SqsQueueClient)`). `index.ts`: `export * from './connection-factory.js'; export * from './connection.js';`.

- [ ] **Step 4: Install + build**

```bash
cd packages/queue-sqs-transport && npm install && npm run build && npm run compile:cjs
```
Expected: compiles clean (methods throw at runtime but the types satisfy `QueueClient`).

- [ ] **Step 5: Commit**

```bash
git add packages/queue-sqs-transport
git commit -m "feat(queue-sqs-transport): package scaffold and SqsQueueClient skeleton"
```

---

### Task 5: `SqsQueueClient.emit` — publish the envelope to SQS (localstack)

**Files:**
- Modify: `packages/queue-sqs-transport/src/connection.ts`
- Create: `packages/queue-sqs-transport/test/{common.ts, sqs-transport.test.ts, docker-compose.yml}`

**Interfaces:**
- Consumes: `getChannelForMessage` (inherited), `@aws-sdk/client-sqs`.
- Produces: `resolve()` builds the `SQSClient`; `emit()` sends `JSON.stringify(message)` to the resolved queue URL.

- [ ] **Step 1: localstack SQS compose + test harness**

`docker-compose.yml`:
```yaml
services:
  localstack:
    image: localstack/localstack:latest
    ports: ['4566:4566']
    environment: [SERVICES=sqs]
```
`common.ts` — a `TestConfiguration` with a `queue` block: one connection `{ service: 'SqsQueueClient', name: 'sqs', options: { region: 'us-east-1', endpoint: 'http://localhost:4566', credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, queueUrl: <created-in-before> } }`, and `routing: { TestJob: '<queueUrl>' }`. In `before`, create the queue via the SDK and capture its URL.

- [ ] **Step 2: Failing emit test**

```ts
it('emit sends the JSON envelope to SQS', async () => {
  const client = await DI.resolve(SqsQueueClient, [connOpts]);
  await client.emit({ Name: 'TestJob', Type: QueueMessageType.Job, CreatedAt: DateTime.now(),
    JobId: 'jid-1', RetryCount: 3, Persistent: true, Priority: 0, Foo: 'bar' });
  const msg = await receiveOne(queueUrl);   // raw SDK ReceiveMessage
  const body = JSON.parse(msg.Body);
  assert.equal(body.Name, 'TestJob');
  assert.equal(body.Type, 'JOB');
  assert.equal(body.JobId, 'jid-1');
  assert.equal(body.Foo, 'bar');
});
```

- [ ] **Step 3: Implement `resolve` + `emit`**

```ts
public async resolve(): Promise<void> {
  const o = this.Options.options as ISqsConnectionOptions;
  this.Sqs = new SQSClient({ region: o.region, endpoint: o.endpoint, credentials: o.credentials });
  if (!o.queueUrl && !this.Options.defaultQueueChannel) {
    throw new InvalidOption('SQS connection needs options.queueUrl or defaultQueueChannel');
  }
}

public async emit(message: IQueueMessage): Promise<void> {
  const urls = this.getChannelForMessage(message);   // routing[Name] || defaultQueueChannel; queue URLs
  const body = JSON.stringify(message);
  await Promise.all(urls.map((QueueUrl) =>
    this.Sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: body }))));
}
```

- [ ] **Step 4: Run against localstack**

```bash
cd packages/queue-sqs-transport/test && docker compose up -d
cd .. && RUN it → npm test  (or npx ts-mocha -p tsconfig.json test/sqs-transport.test.ts)
cd test && docker compose down
```
Expected: emit test passes; the body has `Name`/`Type:"JOB"`/`JobId`.

- [ ] **Step 5: Build + commit**

```bash
cd packages/queue-sqs-transport && npm run build && npm run compile:cjs
cd ../.. && git add packages/queue-sqs-transport
git commit -m "feat(queue-sqs-transport): emit publishes the JSON envelope to SQS"
```

---

### Task 6: `SqsQueueClient.subscribe`/`unsubscribe`/`dispose` — long-poll + ack/nack

**Files:**
- Modify: `packages/queue-sqs-transport/src/connection.ts`
- Modify: `packages/queue-sqs-transport/test/sqs-transport.test.ts`

**Interfaces:**
- Produces: `subscribe` starts a poll loop delivering messages to the callback; delete on success, leave on failure; `unsubscribe`/`dispose` stop the loop.

- [ ] **Step 1: Failing tests**

```ts
it('subscribe delivers a message and deletes it on success', async () => {
  const seen = [];
  await client.subscribe('TestJob' /* or the job class */, async (m) => { seen.push(m); });
  await putRaw(queueUrl, JSON.stringify({ Name: 'TestJob', Type: 'JOB', CreatedAt: DateTime.now().toISO(), JobId: 'j2' }));
  await waitUntil(() => seen.length === 1);
  assert.equal(seen[0].Name, 'TestJob');
  assert.ok(seen[0].CreatedAt.isLuxonDateTime ?? typeof seen[0].CreatedAt === 'object'); // rehydrated
  await waitUntil(async () => (await countMessages(queueUrl)) === 0); // deleted (acked)
  await client.dispose();
});

it('leaves the message on handler failure (nack -> redelivery)', async () => {
  await client.subscribe('TestJob', async () => { throw new Error('boom'); });
  await putRaw(queueUrl, JSON.stringify({ Name: 'TestJob', Type: 'JOB', CreatedAt: DateTime.now().toISO(), JobId: 'j3' }));
  // after the visibility timeout the message is available again; assert it was NOT deleted
  await sleepPastVisibility();
  assert.ok((await countMessages(queueUrl)) >= 1);
  await client.dispose();
});
```

- [ ] **Step 2: Implement**

- `subscribe(eventOrChannel, callback, sid?, durable?)`: resolve URLs (`_.isString(eventOrChannel) ? [eventOrChannel] : this.getChannelForMessage(eventOrChannel)` — mirror STOMP `connection.ts:298`), store a descriptor `{ url, callback, running: true, controller: new AbortController() }` in `this.Subscriptions`, and start a detached async loop:

```ts
while (desc.running) {
  const res = await this.Sqs.send(new ReceiveMessageCommand({
    QueueUrl: desc.url, WaitTimeSeconds: o.waitTimeSeconds ?? 20,
    MaxNumberOfMessages: o.maxMessages ?? 1, VisibilityTimeout: o.visibilityTimeout,
  }), { abortSignal: desc.controller.signal }).catch((e) => { this.Log.warn(...); return null; });
  for (const m of res?.Messages ?? []) {
    let parsed; try { parsed = JSON.parse(m.Body); } catch { /* delete poison or log */ continue; }
    if (typeof parsed.CreatedAt === 'string') parsed.CreatedAt = DateTime.fromISO(parsed.CreatedAt);
    try {
      await desc.callback(parsed);
      await this.Sqs.send(new DeleteMessageCommand({ QueueUrl: desc.url, ReceiptHandle: m.ReceiptHandle })); // ACK
    } catch (err) {
      this.Log.error(err, 'handler failed; leaving message for redelivery'); // NACK: do nothing
    }
  }
}
```

- `unsubscribe(eventOrChannel)`: find the descriptor(s), `desc.running = false; desc.controller.abort()`, delete from the map.
- `dispose()`: stop all descriptors (as above), then `this.Sqs.destroy()`.

Handle the `subscribe` overloads' types to satisfy `QueueClient`. On a poison/unparseable message, log and either delete or leave (leave → it eventually DLQs; deleting avoids a hot loop — pick and note).

- [ ] **Step 3: Run against localstack, prove ack vs nack**

Run the suite. Expected: success-path deletes the message; failure-path leaves it (still present after the visibility window). Confirm the process exits cleanly after `dispose()` (no leaked poll loop).

- [ ] **Step 4: Build + commit**

```bash
cd packages/queue-sqs-transport && npm run build && npm run compile:cjs
cd ../.. && git add packages/queue-sqs-transport
git commit -m "feat(queue-sqs-transport): consume via long-poll; ack by delete, nack by leave

subscribe runs a ReceiveMessage long-poll loop, rehydrates CreatedAt, and
deletes the message on handler success or leaves it on failure (SQS
visibility timeout redelivers, redrive policy dead-letters). unsubscribe and
dispose stop the loop."
```

---

### Task 7: End-to-end — `QueueService` over SQS, consumer writes the row

**Files:**
- Modify: `packages/queue-sqs-transport/test/sqs-transport.test.ts` (add an e2e case), or a new `e2e.test.ts`

**Interfaces:**
- Consumes: Task 1 (consumer-side insert) + Tasks 5-6 (SQS emit/consume).

- [ ] **Step 1: The e2e test**

Bootstrap a full `QueueService` with the SQS connection **and** an in-memory sqlite `queue` ORM connection (so `JobModel` works). Define `@Job() class SqsE2EJob extends QueueJob { execute() { return 'done'; } }`. `consume(SqsE2EJob)`, then `SqsE2EJob.emit({})` (through `QueueService`, which now only stamps JobId — no producer DB write), and assert:
- the message round-tripped through SQS,
- a `queue_jobs` row now exists (created **consumer-side**) with `Name='SqsE2EJob'`, `Status='success'`,
- `execute()` ran (result recorded).

This is the one test proving the whole design: DB-free producer + SQS transport + consumer-side tracking + full job semantics.

- [ ] **Step 2: Run + commit**

```bash
cd packages/queue-sqs-transport/test && docker compose up -d
cd .. && npm test ; cd test && docker compose down
cd ../../.. && git add packages/queue-sqs-transport/test
git commit -m "test(queue-sqs-transport): end-to-end emit+consume writes the row consumer-side"
```

---

### Task 8: Verification

- [ ] **Step 1: Baseline-diff touched packages**

```
queue                 baseline -> now (unit tracking.test green; jobs.test via ActiveMQ green)
queue-stomp-transport baseline -> now
queue-sqs-transport   new: all green vs localstack
queue-http-progress   compiles; status change covered
```

- [ ] **Step 2: Build the touched packages + downstream**

`npm run build && npm run compile:cjs` in `queue`, `queue-sqs-transport`, `queue-stomp-transport`, `queue-amqp-transport`, `queue-http-progress`. Report anything that fails to compile. (`queue-amqp-transport`/`-stomp` inherit the changed core `queue` at runtime, not compile — but rebuild to be safe.)

- [ ] **Step 3: Report**

State what was executed (unit; STOMP e2e vs ActiveMQ; SQS e2e vs localstack) and what was only inspected (AMQP if no RabbitMQ). Confirm the AMQP/STOMP job flow did not regress, and that the SQS e2e writes the row consumer-side.

---

## Notes for the implementer

- **Task 1 is the load-bearing change** — it touches the shared core every transport uses. The `queue/test/jobs.test.ts` ActiveMQ run (Task 2) is the real regression gate; do not declare Task 1 done on the unit test alone.
- **Verify the ORM `.first()` and insert-behavior** against installed `@spinajs/orm` (`model.ts`). `firstOrThrow` already exists; `.first()` returning null-or-model is what the find-or-create needs.
- **The connection name `c`** is in scope in the consume callback (`for (let c of connections)`); use it for `jModel.Connection`.
- **Rehydrate `CreatedAt`** (ISO → Luxon `DateTime`) in the SQS consumer before invoking the callback, mirroring STOMP (`connection.ts:352-354`) — the core reads `Type`/`Name` from the parsed body, but downstream code may expect `CreatedAt` as a `DateTime`.
- **localstack SQS** is enough for the transport tests; no real AWS. The `sn-step-schedules` integration (Step Functions `sqs:sendMessage` + the mailer worker) is a separate follow-up project, not in this plan.
- **Baseline-diff, don't chase green** — this repo carries ~34 pre-existing failures across other packages.
