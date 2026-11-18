import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import { CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IMessageRoutingOption, IQueueMessage } from '@spinajs/queue';
import { CONFORMANCE_MAX_DELAY_MS, conformanceRouting, deadLetterBody, type TransportHarness } from '@spinajs/queue/testing';
import { readMessageAttributes, SqsQueueClient } from '../../src/index.js';
import { SQS_CREDENTIALS, SQS_ENDPOINT, SQS_REGION } from './common.js';

// localstack has no "queue drained" signal, so "nothing more arrives" is a fixed wait, as on the other real brokers
const QUIET_MS = 1500;
// short, so an unsettled message comes back within one case
const VISIBILITY_SECONDS = 2;

const raw = new SQSClient({ region: SQS_REGION, endpoint: SQS_ENDPOINT, credentials: SQS_CREDENTIALS });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function localstackReachable(): Promise<boolean> {
  const endpoint = new URL(SQS_ENDPOINT);
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000, () => done(false));
    socket.once('error', () => done(false));
    socket.connect(Number(endpoint.port || 80), endpoint.hostname, () => done(true));
  });
}

function conf(routing: Record<string, IMessageRoutingOption>) {
  return class extends FrameworkConfiguration {
    protected onLoad(): unknown {
      return { queue: { routing }, logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] } };
    }
  };
}

async function createQueue(name: string, attributes: Record<string, string>): Promise<string> {
  const { QueueUrl } = await raw.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
  if (!QueueUrl) throw new Error(`localstack returned no URL for ${name}`);
  return QueueUrl;
}

async function arnOf(url: string): Promise<string> {
  const { Attributes } = await raw.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }));
  if (!Attributes?.QueueArn) throw new Error(`localstack returned no ARN for ${url}`);
  return Attributes.QueueArn;
}

async function drain(url: string): Promise<{ message: IQueueMessage; headers: Record<string, string> }[]> {
  const found: { message: IQueueMessage; headers: Record<string, string> }[] = [];
  for (;;) {
    const { Messages } = await raw.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }));
    if (!Messages || Messages.length === 0) return found;
    for (const m of Messages) {
      found.push({ message: deadLetterBody(m.Body ?? ''), headers: readMessageAttributes(m.MessageAttributes) });
      await raw.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle }));
    }
  }
}

/** One harness per case, on fresh queues: a work queue, a queue that stands for the topic channel, and a dead-letter queue. */
export async function sqsHarness(o: { fifo: boolean }): Promise<TransportHarness> {
  const id = randomUUID();
  const suffix = o.fifo ? '.fifo' : '';
  const base: Record<string, string> = o.fifo ? { FifoQueue: 'true', ContentBasedDeduplication: 'false' } : {};
  const dlq = await createQueue(`conf-${id}-dlq${suffix}`, base);
  // a FIFO work queue gets an AWS redrive policy, so the transport's maxReceiveCount check meets a real one
  const work = o.fifo ? { ...base, RedrivePolicy: JSON.stringify({ deadLetterTargetArn: await arnOf(dlq), maxReceiveCount: 10 }) } : base;
  const queue = await createQueue(`conf-${id}-jobs${suffix}`, work);
  const topic = await createQueue(`conf-${id}-events${suffix}`, work);

  DI.clearCache();
  // every conformance message carries a MessageId, so on FIFO each one is its own group
  DI.register(conf(conformanceRouting(o.fifo ? { groupBy: 'MessageId' } : {}))).as(Configuration);
  await DI.resolve(Configuration);
  const client = new SqsQueueClient({
    service: 'SqsQueueClient',
    name: `conf-${id}`,
    defaultQueueChannel: queue,
    defaultTopicChannel: topic,
    defaultQueueDeadLetterChannel: dlq,
    options: { region: SQS_REGION, endpoint: SQS_ENDPOINT, credentials: SQS_CREDENTIALS, retryMode: 'transport', waitTimeSeconds: 1, visibilityTimeout: VISIBILITY_SECONDS },
  });
  await client.resolve();

  return {
    client,
    deliverAll: () => sleep(QUIET_MS),
    advance: (ms) => sleep(Math.min(ms, CONFORMANCE_MAX_DELAY_MS + 500)),
    redeliverUnsettled: () => sleep((VISIBILITY_SECONDS + 1) * 1000),
    deadLetters: drain,
    async injectRaw(url, body) {
      await raw.send(new SendMessageCommand({ QueueUrl: url, MessageBody: body, ...(o.fifo ? { MessageGroupId: 'raw', MessageDeduplicationId: randomUUID() } : {}) }));
    },
    async dispose() {
      await client.dispose();
      for (const url of [queue, topic, dlq]) await raw.send(new DeleteQueueCommand({ QueueUrl: url }));
    },
  };
}
