import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { QueueMessageType } from '@spinajs/queue';
import { DateTime } from 'luxon';
import { expect } from 'chai';
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SqsQueueClient } from '../src/connection.js';
import { TestConfiguration, SQS_ENDPOINT, SQS_REGION, SQS_CREDENTIALS } from './common.js';

// raw SDK client used by the test harness ( NOT the transport under test ) to
// create the queue and read messages back, so the assertions prove a real
// round-trip through localstack SQS rather than an in-process mock.
const raw = new SQSClient({
  region: SQS_REGION,
  endpoint: SQS_ENDPOINT,
  credentials: SQS_CREDENTIALS,
});

// per-run queue name so repeated test runs against a long-lived localstack
// don't collide / read each other's leftovers.
const QUEUE_NAME = `sqs-transport-test-${DateTime.now().toMillis()}`;

let queueUrl: string;

/**
 * Poll the queue until at least one message is available or we run out of tries.
 * SQS receive is best-effort; a single ReceiveMessage may return empty even when
 * a message is present.
 */
async function receiveOne(url: string) {
  for (let i = 0; i < 10; i++) {
    const res = await raw.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
      }),
    );

    if (res.Messages && res.Messages.length > 0) {
      return res.Messages[0];
    }
  }

  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Put a raw JSON string straight onto the queue with the harness client so the
 * assertions exercise the transport's *consumer* path independently of its emit.
 */
async function putRaw(url: string, body: string) {
  await raw.send(new SendMessageCommand({ QueueUrl: url, MessageBody: body }));
}

/**
 * Total messages still on the queue - visible + in-flight ( invisible ) + delayed.
 * Summing all three matters here because the subscriber under test is concurrently
 * polling, so a surviving message flips between visible and not-visible.
 */
async function countMessages(url: string): Promise<number> {
  const res = await raw.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'],
    }),
  );

  const a = res.Attributes ?? {};
  return Number(a.ApproximateNumberOfMessages ?? 0) + Number(a.ApproximateNumberOfMessagesNotVisible ?? 0) + Number(a.ApproximateNumberOfMessagesDelayed ?? 0);
}

/**
 * Poll `fn` ( sync or async predicate ) until it returns truthy or we time out.
 */
async function waitUntil(fn: () => boolean | Promise<boolean>, timeoutMs = 20000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('waitUntil timed out');
    }
    await sleep(intervalMs);
  }
}

describe('sqs queue transport', function () {
  this.timeout(60000);

  before(async () => {
    DI.clearCache();
    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);

    const created = await raw.send(new CreateQueueCommand({ QueueName: QUEUE_NAME }));
    queueUrl = created.QueueUrl!;
  });

  after(async () => {
    try {
      if (queueUrl) {
        await raw.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      }
    } catch {
      /* best effort cleanup */
    }
    raw.destroy();
  });

  it('emit sends the JSON envelope to SQS', async () => {
    // resolve the transport pointing its default queue channel at the URL we just
    // created ( getChannelForMessage falls back to defaultQueueChannel for jobs ).
    const client = await DI.resolve(SqsQueueClient, [
      {
        service: 'SqsQueueClient',
        name: 'sqs',
        defaultQueueChannel: queueUrl,
        options: {
          region: SQS_REGION,
          endpoint: SQS_ENDPOINT,
          credentials: SQS_CREDENTIALS,
        },
      },
    ]);

    await client.emit({
      Name: 'TestJob',
      Type: QueueMessageType.Job,
      CreatedAt: DateTime.now(),
      JobId: 'jid-1',
      RetryCount: 3,
      Persistent: true,
      Priority: 0,
      Foo: 'bar',
    } as any);

    const msg = await receiveOne(queueUrl);

    expect(msg, 'no message received from SQS').to.not.be.undefined;

    const body = JSON.parse(msg!.Body!);

    expect(body.Name).to.equal('TestJob');
    expect(body.Type).to.equal('JOB');
    expect(body.JobId).to.equal('jid-1');
    expect(body.Foo).to.equal('bar');

    await client.dispose();
  });

  it('routing-only connection ( no defaultQueueChannel ) resolves and emits via queue.routing', async () => {
    // A dedicated queue so this case never reads the other test's messages.
    const routingQueueName = `${QUEUE_NAME}-routing`;
    const createdRouting = await raw.send(new CreateQueueCommand({ QueueName: routingQueueName }));
    const routingQueueUrl = createdRouting.QueueUrl!;

    // The destination comes *entirely* from the global queue.routing table
    // ( getChannelForMessage reads this.Routing[message.Name] first ). The
    // connection below deliberately has NO queueUrl / defaultQueueChannel /
    // defaultTopicChannel - this is the routing-only shape the reviewer flagged.
    const cfg = await DI.resolve(Configuration);
    cfg.set(['queue', 'routing', 'TestJob'], routingQueueUrl);

    try {
      // resolve() must NOT throw even though no connection-level destination is set.
      const client = await DI.resolve(SqsQueueClient, [
        {
          service: 'SqsQueueClient',
          name: 'sqs-routing-only',
          options: {
            region: SQS_REGION,
            endpoint: SQS_ENDPOINT,
            credentials: SQS_CREDENTIALS,
          },
        },
      ]);

      await client.emit({
        Name: 'TestJob',
        Type: QueueMessageType.Job,
        CreatedAt: DateTime.now(),
        JobId: 'jid-routing',
        RetryCount: 3,
        Persistent: true,
        Priority: 0,
        Foo: 'routed',
      } as any);

      const msg = await receiveOne(routingQueueUrl);

      expect(msg, 'no message received from the routing-table queue').to.not.be.undefined;

      const body = JSON.parse(msg!.Body!);

      expect(body.Name).to.equal('TestJob');
      expect(body.Type).to.equal('JOB');
      expect(body.JobId).to.equal('jid-routing');
      expect(body.Foo).to.equal('routed');

      await client.dispose();
    } finally {
      cfg.set(['queue', 'routing', 'TestJob'], undefined);
      try {
        await raw.send(new DeleteQueueCommand({ QueueUrl: routingQueueUrl }));
      } catch {
        /* best effort cleanup */
      }
    }
  });

  describe('subscribe / unsubscribe / dispose', function () {
    // each consumer test owns a fresh queue and its own client so the poll loops
    // never read each other's messages; the client is always disposed in after().
    let subQueueUrl: string;
    let client: SqsQueueClient;

    async function makeClient(name: string, options: Record<string, unknown>) {
      return DI.resolve(SqsQueueClient, [
        {
          service: 'SqsQueueClient',
          name,
          defaultQueueChannel: subQueueUrl,
          options: {
            region: SQS_REGION,
            endpoint: SQS_ENDPOINT,
            credentials: SQS_CREDENTIALS,
            // short long-poll so the loop cycles / tears down fast in tests
            waitTimeSeconds: 1,
            ...options,
          },
        },
      ]);
    }

    beforeEach(async () => {
      const name = `sqs-sub-test-${DateTime.now().toMillis()}-${Math.floor(Math.random() * 1e6)}`;
      const created = await raw.send(new CreateQueueCommand({ QueueName: name }));
      subQueueUrl = created.QueueUrl!;
    });

    afterEach(async () => {
      if (client) {
        await client.dispose();
        client = undefined as any;
      }
      try {
        await raw.send(new DeleteQueueCommand({ QueueUrl: subQueueUrl }));
      } catch {
        /* best effort cleanup */
      }
    });

    it('delivers a message, rehydrates CreatedAt, and deletes it on success ( ack )', async () => {
      client = await makeClient('sqs-sub-ack', {});

      const seen: any[] = [];
      await client.subscribe(subQueueUrl, async (m) => {
        seen.push(m);
      });

      await putRaw(subQueueUrl, JSON.stringify({ Name: 'TestJob', Type: QueueMessageType.Job, CreatedAt: DateTime.now().toISO(), JobId: 'j-ack' }));

      await waitUntil(() => seen.length === 1);

      expect(seen[0].Name).to.equal('TestJob');
      expect(seen[0].Type).to.equal(QueueMessageType.Job);
      expect(seen[0].JobId).to.equal('j-ack');
      // CreatedAt must be a rehydrated luxon DateTime, not the ISO string off the wire
      expect(DateTime.isDateTime(seen[0].CreatedAt), 'CreatedAt was not rehydrated to a luxon DateTime').to.be.true;

      // ACK proof: the message must be gone from the queue. This assertion fails
      // if DeleteMessage did not run on success ( the message would still be there ).
      await waitUntil(async () => (await countMessages(subQueueUrl)) === 0);
      expect(await countMessages(subQueueUrl)).to.equal(0);
    });

    it('leaves the message on handler failure ( nack -> redelivery )', async () => {
      // small visibility timeout so the left message reappears fast for the assertion
      client = await makeClient('sqs-sub-nack', { visibilityTimeout: 2 });

      let attempts = 0;
      await client.subscribe(subQueueUrl, async () => {
        attempts++;
        throw new Error('boom');
      });

      await putRaw(subQueueUrl, JSON.stringify({ Name: 'TestJob', Type: QueueMessageType.Job, CreatedAt: DateTime.now().toISO(), JobId: 'j-nack' }));

      // wait until the handler has actually run at least once ( proves delivery )
      await waitUntil(() => attempts >= 1);

      // NACK proof: after the visibility window elapses the message is STILL present.
      // This assertion fails if the code wrongly deleted the message on handler error.
      await sleep(3000);
      expect(await countMessages(subQueueUrl), 'message was deleted on failure - should have been left for redelivery').to.be.at.least(1);
    });

    it('unsubscribe stops delivery to the callback', async () => {
      client = await makeClient('sqs-sub-unsub', {});

      const seen: any[] = [];
      await client.subscribe(subQueueUrl, async (m) => {
        seen.push(m);
      });

      client.unsubscribe(subQueueUrl);

      await putRaw(subQueueUrl, JSON.stringify({ Name: 'TestJob', Type: QueueMessageType.Job, CreatedAt: DateTime.now().toISO(), JobId: 'j-unsub' }));

      // give the ( now stopped ) loop ample time to NOT pick it up
      await sleep(3000);
      expect(seen.length, 'callback fired after unsubscribe').to.equal(0);
      // the message is still on the queue since nobody consumed it
      expect(await countMessages(subQueueUrl)).to.be.at.least(1);
    });

    it('dispose stops the poll loop promptly ( abortable long poll ) and the loop actually exits', async () => {
      // a 20s long poll - dispose must abort the in-flight ReceiveMessage so the
      // detached loop actually winds down, not just so dispose() returns fast.
      client = await makeClient('sqs-sub-dispose', { waitTimeSeconds: 20 });

      await client.subscribe(subQueueUrl, async () => undefined);

      // grab the live descriptor BEFORE dispose clears the Subscriptions map so we
      // can observe the loop's own exit flag afterwards.
      const desc = (client as any).Subscriptions.get(subQueueUrl);
      expect(desc, 'subscription descriptor missing').to.not.be.undefined;
      expect(desc.exited, 'loop should still be running before dispose').to.be.false;

      // let the loop enter an in-flight ( up to 20s ) ReceiveMessage
      await sleep(500);

      const start = Date.now();
      await client.dispose();
      client = undefined as any;
      const elapsed = Date.now() - start;

      expect(elapsed, `dispose took ${elapsed}ms - long poll was not aborted`).to.be.lessThan(5000);

      // The discriminating assertion: the detached loop must have genuinely exited
      // its blocking 20s ReceiveMessage. If the abort were removed / broken the loop
      // would stay parked in that receive and `exited` would NOT flip within this
      // bound ( well under the 20s WaitTimeSeconds ), failing the test.
      await waitUntil(() => desc.exited === true, 5000, 50);
      expect(desc.exited, 'poll loop did not exit after dispose - abort not wired').to.be.true;
    });

    it('survives a poison ( null / non-JSON ) message and keeps delivering ( Finding 1 )', async () => {
      // null-body would parse to `null`, and a non-JSON body would throw in
      // JSON.parse. Either one, if unguarded, throws in the detached loop -> an
      // unhandled rejection that kills the worker. Proof of survival: a VALID
      // message put after the poison ones is still delivered.
      client = await makeClient('sqs-sub-poison', {});

      const seen: any[] = [];
      await client.subscribe(subQueueUrl, async (m) => {
        seen.push(m);
      });

      // literal JSON null - JSON.parse succeeds and yields `null`
      await putRaw(subQueueUrl, 'null');
      // not JSON at all - JSON.parse throws a SyntaxError
      await putRaw(subQueueUrl, 'this is not json {');

      // give the loop a moment to chew through the poison messages
      await sleep(1500);

      // the loop must still be alive and able to deliver a subsequent good message
      await putRaw(subQueueUrl, JSON.stringify({ Name: 'TestJob', Type: QueueMessageType.Job, CreatedAt: DateTime.now().toISO(), JobId: 'j-after-poison' }));

      await waitUntil(() => seen.some((m) => m.JobId === 'j-after-poison'));

      expect(seen.some((m) => m.JobId === 'j-after-poison'), 'valid message after poison was not delivered - the loop died on the poison message').to.be.true;
    });
  });
});
