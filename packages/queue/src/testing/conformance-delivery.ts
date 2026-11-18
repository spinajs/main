import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { DateTime } from 'luxon';
import { NonRetryableError } from '@spinajs/durable';
import { unparseableMessage } from '../delivery.js';
import { QueueHeaders } from '../headers.js';
import { PermanentJobFailure } from '../hooks.js';
import { QueueMessageType } from '../interfaces.js';
import type { IMessageRoutingOption, IQueueMessage } from '../interfaces.js';
import { RedeliverLater } from '../redeliver.js';
import type { ConformanceCase, TransportHarness } from './conformance.js';

export const CONFORMANCE_JOB = 'QueueConformanceJob';
export const CONFORMANCE_SLOW_JOB = 'QueueConformanceSlowJob';
export const CONFORMANCE_EVENT = 'QueueConformanceEvent';
export const CONFORMANCE_RETRIED_EVENT = 'QueueConformanceRetriedEvent';

/** The longest delay in CONFORMANCE_ROUTING. A harness on a real broker may cap `advance()` a little above it. */
export const CONFORMANCE_MAX_DELAY_MS = 5000;

/** The delivery routes of the suite. A harness passes `conformanceRouting()` as `queue.routing`; channels come from the connection defaults, so SQS URLs work too. */
export const CONFORMANCE_ROUTING: Record<string, IMessageRoutingOption> = {
  [CONFORMANCE_JOB]: { maxRetries: 2, backoff: { kind: 'fixed', delayMs: 1000 } },
  [CONFORMANCE_SLOW_JOB]: { maxRetries: 1, backoff: { kind: 'fixed', delayMs: CONFORMANCE_MAX_DELAY_MS } },
  [CONFORMANCE_EVENT]: {},
  [CONFORMANCE_RETRIED_EVENT]: { maxRetries: 1, onEventFailure: 'retry', backoff: { kind: 'fixed', delayMs: 1000 } },
};

export const EVENT_FAN_OUT_CASE = 'retries an event with onEventFailure retry, only to the subscriber that failed';

const isQueueMessage = (value: unknown): value is IQueueMessage => typeof value === 'object' && value !== null && typeof Reflect.get(value, 'Name') === 'string';

/** What a harness returns as the `message` of a dead letter: its parsed body, or the stand-in for a body that is not a message. */
export function deadLetterBody(body: string): IQueueMessage {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isQueueMessage(parsed)) return parsed;
  } catch {
    // not JSON: the unparseable case dead-letters such a body on purpose
  }
  return unparseableMessage();
}

const message = (name: string, type: QueueMessageType): IQueueMessage => ({ Name: name, Type: type, CreatedAt: DateTime.now(), Persistent: true, Priority: 0, MessageId: uuidv4() });

function channels(h: TransportHarness): { queue: string; topic: string; dlq: string } {
  const { defaultQueueChannel, defaultTopicChannel, defaultQueueDeadLetterChannel } = h.client.Options;
  assert.ok(defaultQueueChannel && defaultTopicChannel && defaultQueueDeadLetterChannel, 'the harness client needs default queue, topic and dead-letter channels');
  return { queue: defaultQueueChannel, topic: defaultTopicChannel, dlq: defaultQueueDeadLetterChannel };
}

async function settle(h: TransportHarness, rounds: number, stepMs: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await h.deliverAll();
    await h.advance(stepMs);
  }
  await h.deliverAll();
}

async function retriesThenDeadLetters(h: TransportHarness): Promise<void> {
  const { queue, dlq } = channels(h);
  const seen: IQueueMessage[] = [];
  await h.client.subscribe(queue, async (m) => {
    seen.push(m);
    throw new Error('always fails');
  });
  const sent = message(CONFORMANCE_JOB, QueueMessageType.Job);
  await h.client.emit(sent);
  await settle(h, 4, 1000);

  assert.deepEqual(
    seen.map((m) => m.Headers?.[QueueHeaders.RetryCount] ?? '0'),
    ['0', '1', '2'],
    'two retries with a growing x-retry-count',
  );
  assert.ok(
    seen.every((m) => m.MessageId === sent.MessageId),
    'the MessageId survives every retry',
  );
  const dead = await h.deadLetters(dlq);
  assert.equal(dead.length, 1);
  assert.equal(dead[0].message.MessageId, sent.MessageId);
  assert.equal(dead[0].headers[QueueHeaders.RetryCount], '2');
  assert.equal(dead[0].headers[QueueHeaders.Error], 'always fails');
  assert.equal(dead[0].headers[QueueHeaders.OriginalDestination], queue);
}

async function deadLettersAtOnce(h: TransportHarness, failure: () => Error): Promise<void> {
  const { queue, dlq } = channels(h);
  let calls = 0;
  await h.client.subscribe(queue, async () => {
    calls++;
    throw failure();
  });
  const sent = message(CONFORMANCE_JOB, QueueMessageType.Job);
  await h.client.emit(sent);
  await settle(h, 2, 1000);
  assert.equal(calls, 1, 'not retried, whatever maxRetries says');
  assert.deepEqual(
    (await h.deadLetters(dlq)).map((d) => d.message.MessageId),
    [sent.MessageId],
  );
}

const nonRetryableGoesStraightToDlq = (h: TransportHarness) => deadLettersAtOnce(h, () => new PermanentJobFailure('denied', 'no access'));
const givesUpOnNonRetryableError = (h: TransportHarness) => deadLettersAtOnce(h, () => new NonRetryableError('card expired'));

// one subscription gets both events, so a transport that acks every failure fails here as well as one that retries every failure
async function dropsFailedEventByDefault(h: TransportHarness): Promise<void> {
  const { topic, dlq } = channels(h);
  const seen: string[] = [];
  await h.client.subscribe(
    topic,
    async (m) => {
      seen.push(m.Name);
      throw new Error('event handler fails');
    },
    'conformance-drop',
  );
  await h.client.emit(message(CONFORMANCE_EVENT, QueueMessageType.Event));
  await h.client.emit(message(CONFORMANCE_RETRIED_EVENT, QueueMessageType.Event));
  await settle(h, 2, 1000);
  const callsOf = (name: string) => seen.filter((n) => n === name).length;
  assert.equal(callsOf(CONFORMANCE_EVENT), 1, 'a failed event is not retried by default');
  assert.equal(callsOf(CONFORMANCE_RETRIED_EVENT), 2, 'an event routed with onEventFailure retry is retried');
  const dead = await h.deadLetters(dlq);
  assert.deepEqual(
    dead.filter((d) => d.message.Name === CONFORMANCE_EVENT),
    [],
    'a dropped event is not dead-lettered',
  );
}

async function retriesEventOnlyForFailingSubscriber(h: TransportHarness): Promise<void> {
  const { topic } = channels(h);
  const calls = { a: 0, b: 0 };
  await h.client.subscribe(
    topic,
    async () => {
      calls.a++;
      throw new Error('a always fails');
    },
    'conformance-a',
  );
  await h.client.subscribe(topic, async () => void calls.b++, 'conformance-b');
  await h.client.emit(message(CONFORMANCE_RETRIED_EVENT, QueueMessageType.Event));
  await settle(h, 2, 1000);
  assert.deepEqual(calls, { a: 2, b: 1 }, 'one retry (maxRetries 1), to the failing subscriber only');
}

// a 250 * 2^n value, so AMQP's forced-delay bucket equals it; above two deliverAll() rounds of a real broker, below CONFORMANCE_MAX_DELAY_MS
const FORCED_DELAY_MS = 4000;

// the handler's own RedeliverLater bypasses the retry count (plan 1's contract)
async function redeliversWhenAsked(h: TransportHarness): Promise<void> {
  const { topic } = channels(h);
  let calls = 0;
  await h.client.subscribe(
    topic,
    async () => {
      if (++calls === 1) throw new RedeliverLater(FORCED_DELAY_MS);
    },
    'conformance-later',
  );
  await h.client.emit(message(CONFORMANCE_EVENT, QueueMessageType.Event));
  await h.deliverAll();
  await h.deliverAll();
  assert.equal(calls, 1, 'the redelivery waits for the delay RedeliverLater asked for');
  await h.advance(CONFORMANCE_MAX_DELAY_MS);
  await h.deliverAll();
  assert.equal(calls, 2, 'RedeliverLater redelivers even under onEventFailure: drop');
}

async function waitsForTheDelay(h: TransportHarness): Promise<void> {
  const { queue } = channels(h);
  let calls = 0;
  await h.client.subscribe(queue, async () => {
    if (++calls === 1) throw new Error('fails once');
  });
  await h.client.emit(message(CONFORMANCE_SLOW_JOB, QueueMessageType.Job));
  await h.deliverAll();
  await h.deliverAll();
  assert.equal(calls, 1, 'the retry is not delivered before its delay');
  await h.advance(CONFORMANCE_MAX_DELAY_MS);
  await h.deliverAll();
  assert.equal(calls, 2, 'the retry is delivered once its delay has passed');
}

async function leavesCrashedDeliveryUnsettled(h: TransportHarness): Promise<void> {
  assert.ok(h.redeliverUnsettled, 'the suite runs this case only on a harness with redeliverUnsettled');
  const { queue, dlq } = channels(h);
  let calls = 0;
  await h.client.subscribe(queue, async () => {
    if (++calls === 1) throw Object.assign(new Error('the consumer died'), { crash: true });
  });
  await h.client.emit(message(CONFORMANCE_JOB, QueueMessageType.Job));
  await h.deliverAll();
  assert.equal(calls, 1);
  await h.redeliverUnsettled();
  await h.deliverAll();
  assert.equal(calls, 2, 'the broker hands the unsettled delivery out again');
  assert.deepEqual(await h.deadLetters(dlq), [], 'a crash is not a failed attempt');
}

async function deadLettersUnparseable(h: TransportHarness): Promise<void> {
  assert.ok(h.injectRaw, 'the suite runs this case only on a harness with injectRaw');
  const { queue, dlq } = channels(h);
  await h.client.subscribe(queue, async () => assert.fail('an unparseable body never reaches the handler'));
  await h.injectRaw(queue, '{not json');
  await settle(h, 1, 1000);
  assert.equal((await h.deadLetters(dlq)).length, 1);
}

export const DELIVERY_CASES: ConformanceCase[] = [
  ['retries a job maxRetries times, then dead-letters it with x-error, x-retry-count and x-original-destination', retriesThenDeadLetters],
  ['dead-letters a PermanentJobFailure at once', nonRetryableGoesStraightToDlq],
  ['dead-letters a NonRetryableError at once', givesUpOnNonRetryableError],
  ['does not deliver a retry before its delay', waitsForTheDelay],
  ['drops a failed event by default', dropsFailedEventByDefault],
  [EVENT_FAN_OUT_CASE, retriesEventOnlyForFailingSubscriber],
  ['redelivers an event whose handler asked for a later delivery, whatever onEventFailure says', redeliversWhenAsked],
  ['leaves a crashed delivery unsettled, so the broker redelivers it', leavesCrashedDeliveryUnsettled, 'redeliverUnsettled'],
  ['dead-letters an unparseable body', deadLettersUnparseable, 'injectRaw'],
];
