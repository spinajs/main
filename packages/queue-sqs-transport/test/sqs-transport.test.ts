import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { QueueMessageType } from '@spinajs/queue';
import { DateTime } from 'luxon';
import { expect } from 'chai';
import { CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
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
});
