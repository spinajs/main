import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { DateTime } from 'luxon';
import { QueueMessageType } from '../interfaces.js';
import type { IQueueMessage, QueueClient } from '../interfaces.js';

/** What a transport's test setup gives the conformance suite. One harness serves one case. */
export interface TransportHarness {
  client: QueueClient;
  /** Returns once every message the broker can deliver now has been handed to its subscribers and settled. */
  deliverAll(): Promise<void>;
  /** Moves the broker's clock (retry delays, scheduled delivery) forward. */
  advance(ms: number): Promise<void>;
  deadLetters(channel: string): Promise<{ message: IQueueMessage; headers: Record<string, string> }[]>;
  dispose(): Promise<void>;
}

const CONFORMANCE_MESSAGE = 'QueueConformancePing';

function conformanceMessage(type: QueueMessageType, extra: Partial<IQueueMessage> = {}): IQueueMessage {
  return { Name: CONFORMANCE_MESSAGE, Type: type, CreatedAt: DateTime.now(), Persistent: true, Priority: 0, MessageId: uuidv4(), ...extra };
}

function channelOf(harness: TransportHarness, type: QueueMessageType): string {
  const channel = type === QueueMessageType.Job ? harness.client.Options.defaultQueueChannel : harness.client.Options.defaultTopicChannel;
  assert.ok(channel, `the harness client needs a default ${type === QueueMessageType.Job ? 'queue' : 'topic'} channel`);
  return channel;
}

async function acksOnSuccess(harness: TransportHarness): Promise<void> {
  const channel = channelOf(harness, QueueMessageType.Job);
  const received: IQueueMessage[] = [];
  await harness.client.subscribe(channel, async (m) => void received.push(m));

  await harness.client.emit(conformanceMessage(QueueMessageType.Job));
  await harness.deliverAll();
  await harness.advance(60_000);
  await harness.deliverAll();

  assert.equal(received.length, 1, 'a message whose handler succeeded is delivered once');
  const dlq = harness.client.Options.defaultQueueDeadLetterChannel;
  if (dlq) assert.deepEqual(await harness.deadLetters(dlq), [], 'nothing is dead-lettered');
}

async function keepsMessageId(harness: TransportHarness): Promise<void> {
  const channel = channelOf(harness, QueueMessageType.Event);
  const received: IQueueMessage[] = [];
  await harness.client.subscribe(channel, async (m) => void received.push(m));

  const sent = conformanceMessage(QueueMessageType.Event, { Headers: { 'x-conformance': 'round-trip' } });
  await harness.client.emit(sent);
  await harness.deliverAll();

  assert.equal(received.length, 1);
  assert.equal(received[0].MessageId, sent.MessageId);
  assert.equal(received[0].Headers?.['x-conformance'], 'round-trip');
}

const CASES: [string, (harness: TransportHarness) => Promise<void>][] = [
  ['acks a message whose handler succeeded', acksOnSuccess],
  ['keeps the MessageId and headers across a round trip', keepsMessageId],
];

/** Registers a mocha `describe()` that runs the shared transport cases, each on a fresh harness from `factory`. */
export function describeQueueTransportConformance(name: string, factory: () => Promise<TransportHarness>): void {
  describe(`queue transport conformance: ${name}`, function () {
    // A harness may start a broker connection or a DI container per case.
    this.timeout(60_000);
    for (const [title, run] of CASES) {
      it(title, async () => {
        const harness = await factory();
        try {
          await run(harness);
        } finally {
          await harness.dispose();
        }
      });
    }
  });
}
