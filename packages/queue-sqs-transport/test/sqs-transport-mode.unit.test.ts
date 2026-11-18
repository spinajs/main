import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Job, QueueJob, QueueHeaders, QueueMessageType, RedeliverLater, type IMessageRoutingOption, type IQueueJob, type IQueueMessage } from '@spinajs/queue';
import { DLQ, FIFO, FIFO_DLQ, RecordingSqsClient, recordingClient, STANDARD } from './support/recording-client.js';

@Job()
class OrderJob extends QueueJob {
  public execute(): Promise<void> {
    return Promise.resolve();
  }
}

// taken from a message instance, so the test needs no luxon import of its own
const createdAt = new OrderJob().CreatedAt;

const job = (extra: Partial<IQueueJob> = {}): IQueueJob => ({ Name: 'OrderJob', Type: QueueMessageType.Job, CreatedAt: createdAt, Persistent: true, Priority: 0, MessageId: 'm-1', RetryCount: 2, ...extra });
const event = (): IQueueMessage => ({ Name: 'OrderPlaced', Type: QueueMessageType.Event, CreatedAt: createdAt, Persistent: true, Priority: 0, MessageId: 'm-1' });
const fails = (error: Error) => () => Promise.reject(error);
const failure = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => undefined,
    (error: unknown) => error,
  );

// no route here has a groupBy: these cases consume, and consuming never reads it
const ROUTING: Record<string, IMessageRoutingOption> = { OrderJob: { backoff: { kind: 'fixed', delayMs: 30_000 } } };
const transport = (queue: string, dlq?: string, routing: Record<string, unknown> = ROUTING) => recordingClient({ queue, dlq, routing, options: { retryMode: 'transport' } });

describe('sqs transport: retryMode', () => {
  afterEach(() => DI.clearCache());

  it('rejects resolve() for an unknown options.retryMode', async () => {
    expect(await failure(recordingClient({ queue: STANDARD, options: { retryMode: 'both' } }))).to.be.instanceOf(InvalidArgument);
  });

  it('standard queue: retries with a delayed copy that carries the decision headers, and deletes the original', async () => {
    const c = await transport(STANDARD);
    await c.receive(STANDARD, job(), { handler: fails(new Error('boom')) });

    expect(c.sent).to.have.length(1);
    expect(c.sent[0]).to.include({ QueueUrl: STANDARD, DelaySeconds: 30 });
    expect(c.sent[0].MessageAttributes?.[QueueHeaders.RetryCount]?.StringValue).to.equal('1');
    expect(c.sent[0].MessageAttributes?.[QueueHeaders.Error]?.StringValue).to.equal('boom');
    expect(c.sent[0].MessageBody).to.contain('"x-retry-count":"1"');
    expect(c.deleted).to.deep.equal(['rh-1']);
  });

  it('standard queue: counts the attempt from the x-retry-count attribute and dead-letters an exhausted job with x-original-destination', async () => {
    const c = await transport(STANDARD, DLQ);
    await c.receive(STANDARD, job(), { attributes: { [QueueHeaders.RetryCount]: '2' }, handler: fails(new Error('boom')) });

    expect(c.sent).to.have.length(1);
    expect(c.sent[0].QueueUrl).to.equal(DLQ);
    expect(c.sent[0].MessageBody).to.equal(JSON.stringify(job()));
    expect(c.sent[0].MessageAttributes?.[QueueHeaders.OriginalDestination]?.StringValue).to.equal(STANDARD);
    expect(c.sent[0].MessageAttributes?.[QueueHeaders.RetryCount]?.StringValue).to.equal('2');
    expect(c.deleted).to.deep.equal(['rh-1']);
  });

  it('standard queue: drops an exhausted job, with a delete, when there is no dead-letter queue', async () => {
    const c = await transport(STANDARD);
    await c.receive(STANDARD, job({ RetryCount: 0 }), { handler: fails(new Error('boom')) });
    expect(c.sent).to.deep.equal([]);
    expect(c.deleted).to.deep.equal(['rh-1']);
  });

  it('standard queue: dead-letters a NonRetryableError job on its first failure, whatever retries are left', async () => {
    const c = await transport(STANDARD, DLQ);
    // matched by name, as a NonRetryableError from another copy of @spinajs/durable is; the package does not depend on durable
    await c.receive(STANDARD, job({ RetryCount: 5 }), { handler: fails(Object.assign(new Error('card expired'), { name: 'NonRetryableError' })) });

    expect(c.sent.map((s) => s.QueueUrl)).to.deep.equal([DLQ]);
    expect(c.sent[0].MessageAttributes?.[QueueHeaders.RetryCount]?.StringValue).to.equal('0');
    expect(c.deleted).to.deep.equal(['rh-1']);
  });

  it('standard queue: re-sends a RedeliverLater after its delay without counting it as a retry', async () => {
    const c = await transport(STANDARD, DLQ);
    await c.receive(STANDARD, job(), { attributes: { [QueueHeaders.RetryCount]: '1' }, handler: fails(new RedeliverLater(5000)) });

    expect(c.sent).to.have.length(1);
    expect(c.sent[0]).to.include({ QueueUrl: STANDARD, DelaySeconds: 5 });
    expect(c.sent[0].MessageAttributes?.[QueueHeaders.RetryCount]?.StringValue).to.equal('1');
    expect(c.deleted).to.deep.equal(['rh-1']);
  });

  it('deletes a failed event, the 4.x default', async () => {
    const c = await transport(STANDARD, DLQ);
    await c.receive(STANDARD, event(), { handler: fails(new Error('boom')) });
    expect(c.sent).to.deep.equal([]);
    expect(c.deleted).to.deep.equal(['rh-1']);
  });

  it('FIFO: retries by extending the visibility, counts attempts by ApproximateReceiveCount and shows the count to the handler', async () => {
    const c = await transport(FIFO);
    const seen: (string | undefined)[] = [];
    await c.receive(FIFO, job({ RetryCount: 3 }), {
      system: { ApproximateReceiveCount: '2', MessageGroupId: 'c-7' },
      handler: (m) => {
        seen.push(m.Headers?.[QueueHeaders.RetryCount]);
        return Promise.reject(new Error('boom'));
      },
    });

    expect(seen).to.deep.equal(['1']);
    expect(c.visibility).to.deep.equal([{ url: FIFO, seconds: 30 }]);
    expect(c.sent).to.deep.equal([]);
    expect(c.deleted).to.deep.equal([]);
  });

  it('FIFO: caps the visibility of a retry at 11 hours', async () => {
    const c = await transport(FIFO, undefined, { OrderJob: { backoff: { kind: 'fixed', delayMs: 86_400_000 } } });
    await c.receive(FIFO, job(), { system: { ApproximateReceiveCount: '1', MessageGroupId: 'c-7' }, handler: fails(new Error('boom')) });
    expect(c.visibility).to.deep.equal([{ url: FIFO, seconds: 39_600 }]);
  });

  it('FIFO: dead-letters an exhausted job into the group it was received in, with its own dedup id', async () => {
    const c = await transport(FIFO, FIFO_DLQ);
    await c.receive(FIFO, job(), { system: { ApproximateReceiveCount: '3', MessageGroupId: 'c-7' }, handler: fails(new Error('boom')) });

    expect(c.sent).to.have.length(1);
    expect(c.sent[0]).to.include({ QueueUrl: FIFO_DLQ, MessageGroupId: 'c-7', MessageDeduplicationId: 'm-1:dead' });
    expect(c.sent[0].MessageAttributes?.[QueueHeaders.RetryCount]?.StringValue).to.equal('2');
    expect(c.deleted).to.deep.equal(['rh-1']);
  });

  it('FIFO: a forced redelivery extends the visibility, and the receive it causes counts as an attempt', async () => {
    const c = await transport(FIFO, FIFO_DLQ);
    await c.receive(FIFO, job(), { system: { ApproximateReceiveCount: '1', MessageGroupId: 'c-7' }, handler: fails(new RedeliverLater(5000)) });
    expect(c.visibility).to.deep.equal([{ url: FIFO, seconds: 5 }]);
    expect(c.sent).to.deep.equal([]);

    // the redelivery arrives with receive count 2: the next ordinary failure is decided as attempt 1, not 0
    await c.receive(FIFO, job({ RetryCount: 1 }), { system: { ApproximateReceiveCount: '2', MessageGroupId: 'c-7' }, handler: fails(new Error('boom')) });
    expect(c.sent.map((s) => s.QueueUrl)).to.deep.equal([FIFO_DLQ]);
  });

  describe('FIFO redrive policy at subscribe', () => {
    const routing = { OrderJob: { channel: FIFO, maxRetries: 3 } };
    /** What subscribe() rejects with, or undefined when the subscription is made. */
    const subscribing = async (options: Record<string, unknown>, prepare: (c: RecordingSqsClient) => void): Promise<unknown> => {
      const c = await recordingClient({ queue: FIFO, routing, options });
      prepare(c);
      const error = await failure(c.subscribe(OrderJob, () => Promise.resolve()));
      await c.dispose();
      return error;
    };
    const TRANSPORT = { retryMode: 'transport' };
    const denied = (c: RecordingSqsClient) => {
      c.redriveError = new Error('AccessDenied');
    };

    it('subscribes a FIFO queue without a redrive policy, or with one that holds the retries', async () => {
      expect(await subscribing(TRANSPORT, () => undefined)).to.equal(undefined);
      expect(await subscribing(TRANSPORT, (c) => c.redrive.set(FIFO, JSON.stringify({ deadLetterTargetArn: 'arn', maxReceiveCount: 5 })))).to.equal(undefined);
    });

    it('refuses to subscribe a FIFO queue whose redrive policy cannot hold the retries, naming the queue, the count and the retries', async () => {
      const error = await subscribing(TRANSPORT, (c) => c.redrive.set(FIFO, JSON.stringify({ deadLetterTargetArn: 'arn', maxReceiveCount: '4' })));
      expect(error).to.be.instanceOf(InvalidArgument);
      expect(String(error)).to.contain(FIFO).and.to.contain('maxReceiveCount 4').and.to.contain('maxRetries 3').and.to.contain('above 4');
    });

    it('subscribes, unchecked, a FIFO queue whose redrive policy cannot be read', async () => {
      expect(await subscribing(TRANSPORT, (c) => c.redrive.set(FIFO, 'not json'))).to.equal(undefined);
      expect(await subscribing(TRANSPORT, denied)).to.equal(undefined);
    });

    it('dead-letters, with its headers, a job whose own RetryCount the redrive policy cannot hold', async () => {
      const c = await recordingClient({ queue: FIFO, dlq: FIFO_DLQ, routing, options: TRANSPORT });
      c.redrive.set(FIFO, JSON.stringify({ deadLetterTargetArn: 'arn', maxReceiveCount: 5 }));
      await c.subscribe(OrderJob, () => Promise.resolve());

      // RetryCount 9 on a queue that hands a message out 5 times: decided as 3 retries
      await c.receive(FIFO, job({ RetryCount: 9 }), { system: { ApproximateReceiveCount: '3', MessageGroupId: 'c-7' }, handler: fails(new Error('boom')) });
      expect(c.visibility).to.have.length(1);
      expect(c.sent).to.deep.equal([]);

      await c.receive(FIFO, job({ RetryCount: 9 }), { system: { ApproximateReceiveCount: '4', MessageGroupId: 'c-7' }, handler: fails(new Error('boom')) });
      expect(c.sent.map((s) => s.QueueUrl)).to.deep.equal([FIFO_DLQ]);
      expect(c.sent[0].MessageAttributes?.[QueueHeaders.RetryCount]?.StringValue).to.equal('3');
      expect(c.sent[0].MessageAttributes?.[QueueHeaders.Error]?.StringValue).to.equal('boom');
      await c.dispose();
    });

    it('does not cap a job on a FIFO queue whose redrive policy could not be read', async () => {
      const c = await recordingClient({ queue: FIFO, dlq: FIFO_DLQ, routing, options: TRANSPORT });
      denied(c);
      await c.subscribe(OrderJob, () => Promise.resolve());

      await c.receive(FIFO, job({ RetryCount: 9 }), { system: { ApproximateReceiveCount: '4', MessageGroupId: 'c-7' }, handler: fails(new Error('boom')) });
      expect(c.visibility).to.have.length(1);
      expect(c.sent).to.deep.equal([]);
      await c.dispose();
    });

    it('does not read the redrive policy in redrive mode', async () => {
      expect(await subscribing({}, denied)).to.equal(undefined);
    });
  });

  it('redrive mode leaves a failed message and an unparseable body alone', async () => {
    const c = await recordingClient({ queue: STANDARD, dlq: DLQ, routing: ROUTING });
    await c.receive(STANDARD, job(), { handler: fails(new Error('boom')) });
    await c.deliver(STANDARD, '{nope');
    expect(c.sent).to.deep.equal([]);
    expect(c.deleted).to.deep.equal([]);
  });

  it('never decides a crash', async () => {
    const c = await transport(STANDARD, DLQ);
    await c.receive(STANDARD, job(), { handler: fails(Object.assign(new Error('dead'), { crash: true })) });
    expect(c.sent).to.deep.equal([]);
    expect(c.deleted).to.deep.equal([]);
    expect(c.visibility).to.deep.equal([]);
  });

  it('standard queue: dead-letters an unparseable body as it is, keeping the message id attribute', async () => {
    const c = await transport(STANDARD, DLQ);
    await c.deliver(STANDARD, '{nope', { attributes: { [QueueHeaders.MessageId]: 'm-7' } });

    expect(c.sent).to.have.length(1);
    expect(c.sent[0]).to.include({ QueueUrl: DLQ, MessageBody: '{nope' });
    expect(c.sent[0].MessageAttributes?.[QueueHeaders.MessageId]?.StringValue).to.equal('m-7');
    expect(c.sent[0].MessageAttributes?.[QueueHeaders.OriginalDestination]?.StringValue).to.equal(STANDARD);
    expect(c.deleted).to.deep.equal(['rh-1']);
  });

  it('FIFO: dead-letters an unparseable body into the group it was received in, deduplicated by the SQS message id', async () => {
    const c = await transport(FIFO, FIFO_DLQ);
    await c.deliver(FIFO, '{nope', { system: { ApproximateReceiveCount: '1', MessageGroupId: 'g-1' } });

    expect(c.sent).to.have.length(1);
    expect(c.sent[0]).to.include({ QueueUrl: FIFO_DLQ, MessageBody: '{nope', MessageGroupId: 'g-1', MessageDeduplicationId: 'sqs-1:dead' });
    expect(c.deleted).to.deep.equal(['rh-1']);
  });
});
