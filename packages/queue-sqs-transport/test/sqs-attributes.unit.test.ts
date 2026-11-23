import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Event, QueueEvent, QueueHeaders, QueueMessageType, type IQueueMessage } from '@spinajs/queue';
import { MAX_SQS_DELAY_MS, NOT_BEFORE_ATTRIBUTE, readMessageAttributes, toMessageAttributes } from '../src/index.js';
import { FIFO, recordingClient, STANDARD } from './support/recording-client.js';

interface OrderPlaced extends IQueueMessage {
  CustomerId?: unknown;
}

@Event()
class OrderShipped extends QueueEvent {}

// taken from a message instance, so the test needs no luxon import of its own
const createdAt = new OrderShipped().CreatedAt;

const message = (extra: Partial<OrderPlaced> = {}): OrderPlaced => ({ Name: 'OrderPlaced', Type: QueueMessageType.Event, CreatedAt: createdAt, Persistent: true, Priority: 0, MessageId: 'm-1', ...extra });

const failure = (run: Promise<unknown>): Promise<unknown> => run.then(
  () => undefined,
  (error: unknown) => error,
);

const MAX_TIMER_MS = 2 ** 31 - 1;

describe('sqs transport: attributes, FIFO, delays', () => {
  afterEach(() => DI.clearCache());

  it('puts the standard headers first and keeps at most 10 attributes', () => {
    const headers = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`h${i}`, `v${i}`]));
    const attrs = toMessageAttributes(message({ Headers: { ...headers, [QueueHeaders.TraceParent]: 'tp' } }));
    expect(Object.keys(attrs)).to.have.length(10);
    expect(Object.keys(attrs).slice(0, 2)).to.deep.equal([QueueHeaders.MessageId, QueueHeaders.TraceParent]);
    expect(readMessageAttributes(attrs)[QueueHeaders.MessageId]).to.equal('m-1');
  });

  it('leaves out the names SQS refuses and empty values', () => {
    const attrs = toMessageAttributes(message({ Headers: { 'bad name!': 'x', 'AWS.reserved': 'x', 'amazon.reserved': 'x', empty: '', ok: '1' } }));
    expect(Object.keys(attrs)).to.deep.equal([QueueHeaders.MessageId, 'ok']);
  });

  it('leaves out names with a leading, trailing or doubled period, and names over 256 characters', () => {
    const longest = 'n'.repeat(256);
    const attrs = toMessageAttributes(message({ Headers: { '.lead': 'x', 'trail.': 'x', 'a..b': 'x', ['n'.repeat(257)]: 'x', [longest]: 'x', 'a.b': 'x' } }));
    expect(Object.keys(attrs)).to.deep.equal([QueueHeaders.MessageId, longest, 'a.b']);
  });

  it('leaves out values with characters SQS refuses, and keeps tabs, newlines and astral characters', () => {
    const attrs = toMessageAttributes(message({ Headers: { nul: 'a\u0000b', bell: 'a\u0007', noncharacter: 'a￿', lone: 'a\uD800', ok: 'a\tb\r\n\u{1F600}' } }));
    expect(Object.keys(attrs)).to.deep.equal([QueueHeaders.MessageId, 'ok']);
  });

  it('leaves out a value that would push the attributes past their byte budget, and keeps the smaller ones after it', () => {
    const attrs = toMessageAttributes(message({ Headers: { [QueueHeaders.TraceParent]: 'tp', big: 'x'.repeat(8192), small: 's' } }));
    expect(Object.keys(attrs)).to.deep.equal([QueueHeaders.MessageId, QueueHeaders.TraceParent, 'small']);
  });

  it('takes the not-before attribute from the transport only, never from the message headers', () => {
    expect(toMessageAttributes(message({ Headers: { [NOT_BEFORE_ATTRIBUTE]: '1' } }))).to.not.have.property(NOT_BEFORE_ATTRIBUTE);
    expect(Object.keys(toMessageAttributes(message({ Headers: { a: '1' } }), { [NOT_BEFORE_ATTRIBUTE]: '5' }))).to.deep.equal([QueueHeaders.MessageId, NOT_BEFORE_ATTRIBUTE, 'a']);
  });

  it('sends MessageAttributes on a standard queue, and no FIFO ids', async () => {
    const c = await recordingClient({ queue: STANDARD });
    await c.emit(message());
    expect(c.sent[0].MessageAttributes?.[QueueHeaders.MessageId]).to.deep.equal({ DataType: 'String', StringValue: 'm-1' });
    expect(c.sent[0]).to.not.have.property('MessageGroupId');
    expect(c.sent[0]).to.not.have.property('MessageDeduplicationId');
  });

  it('gives a FIFO send its group id from the routing groupBy and its dedup id from the MessageId', async () => {
    const c = await recordingClient({ queue: FIFO, routing: { OrderPlaced: { groupBy: 'CustomerId' } } });
    await c.emit(message({ CustomerId: 'c-7' }));
    await c.emit(message({ CustomerId: 42, MessageId: 'm-2' }));
    await c.emit(message({ CustomerId: 'g'.repeat(128), MessageId: 'm-3' }));
    expect(c.sent[0]).to.include({ MessageGroupId: 'c-7', MessageDeduplicationId: 'm-1' });
    expect(c.sent[1]).to.include({ MessageGroupId: '42', MessageDeduplicationId: 'm-2' });
    expect(c.sent[2]).to.include({ MessageGroupId: 'g'.repeat(128) });
  });

  it('refuses a FIFO send without groupBy, or whose groupBy field holds no id, before anything is sent', async () => {
    const unrouted = await recordingClient({ queue: FIFO });
    expect(await failure(unrouted.emit(message({ CustomerId: 'c-7' })))).to.be.instanceOf(InvalidArgument);
    expect(unrouted.sent).to.deep.equal([]);

    const routed = await recordingClient({ queue: FIFO, routing: { OrderPlaced: { groupBy: 'CustomerId' } } });
    expect(await failure(routed.emit(message()))).to.be.instanceOf(InvalidArgument);
    expect(await failure(routed.emit(message({ CustomerId: '' })))).to.be.instanceOf(InvalidArgument);
    expect(routed.sent).to.deep.equal([]);
  });

  it('refuses a FIFO group id SQS would refuse: over 128 characters, blanks, non-ASCII, or a number that is not finite', async () => {
    const c = await recordingClient({ queue: FIFO, routing: { OrderPlaced: { groupBy: 'CustomerId' } } });
    for (const [i, CustomerId] of ['g'.repeat(129), 'c 7', 'c\t7', 'zażółć', Number.NaN, Number.POSITIVE_INFINITY, true, { id: 1 }].entries()) {
      expect(await failure(c.emit(message({ CustomerId }))), `case ${i}`).to.be.instanceOf(InvalidArgument);
    }
    expect(c.sent).to.deep.equal([]);
  });

  it('refuses a FIFO send whose groupBy is not a field name, as a configuration without the routing schema can give it', async () => {
    for (const groupBy of [true, 5, ' ', 'true']) {
      const c = await recordingClient({ queue: FIFO, routing: { OrderPlaced: { groupBy } } });
      expect(await failure(c.emit(message({ CustomerId: 'c-7' }))), String(groupBy)).to.be.instanceOf(InvalidArgument);
      expect(c.sent).to.deep.equal([]);
    }
  });

  it('gives a FIFO send whose MessageId SQS would refuse a dedup id derived from it, the same for the same MessageId', async () => {
    const c = await recordingClient({ queue: FIFO, routing: { OrderPlaced: { groupBy: 'CustomerId' } } });
    await c.emit(message({ CustomerId: 'c-7', MessageId: 'order 7 placed' }));
    await c.emit(message({ CustomerId: 'c-7', MessageId: 'order 7 placed' }));
    await c.emit(message({ CustomerId: 'c-7', MessageId: 'i'.repeat(129) }));
    await c.emit(message({ CustomerId: 'c-7', MessageId: 'i'.repeat(128) }));
    const ids = c.sent.map((s) => s.MessageDeduplicationId ?? '');
    expect(ids[0]).to.match(/^[0-9a-f]{64}$/);
    expect(ids[1]).to.equal(ids[0]);
    expect(ids[2]).to.match(/^[0-9a-f]{64}$/);
    expect(ids[3]).to.equal('i'.repeat(128));
  });

  it('subscribes a consume-only service to a FIFO queue whose route has no groupBy, and handles what it receives', async () => {
    const c = await recordingClient({ queue: STANDARD, routing: { OrderShipped: { channel: FIFO } } });
    expect(await failure(c.subscribe(OrderShipped, () => Promise.resolve()))).to.equal(undefined);

    const got: IQueueMessage[] = [];
    await c.receive(FIFO, message({ Name: 'OrderShipped' }), {
      system: { ApproximateReceiveCount: '1', MessageGroupId: 'g-1' },
      handler: (m) => {
        got.push(m);
        return Promise.resolve();
      },
    });
    expect(got.map((m) => m.MessageId)).to.deep.equal(['m-1']);
    expect(c.deleted).to.deep.equal(['rh-1']);
    expect(c.sent).to.deep.equal([]);
    await c.dispose();
  });

  it('turns ScheduleDelay into DelaySeconds, and a longer delay into a not-before attribute', async () => {
    const c = await recordingClient({ queue: STANDARD });
    await c.emit(message({ ScheduleDelay: 30_000 }));
    expect(c.sent[0].DelaySeconds).to.equal(30);
    await c.emit(message({ ScheduleDelay: 3_600_000 }));
    expect(c.sent[1].DelaySeconds).to.equal(900);
    expect(c.sent[1].MessageAttributes?.[NOT_BEFORE_ATTRIBUTE]?.StringValue).to.equal(String(1_000_000 + 3_600_000));
  });

  it('keeps DelaySeconds a whole number from 1 to 900, and adds the not-before attribute only past 900 s', async () => {
    const c = await recordingClient({ queue: STANDARD });
    for (const ScheduleDelay of [1, 1500, MAX_SQS_DELAY_MS, MAX_SQS_DELAY_MS + 1]) await c.emit(message({ ScheduleDelay }));
    expect(c.sent.map((s) => s.DelaySeconds)).to.deep.equal([1, 2, 900, 900]);
    expect(c.sent.map((s) => s.MessageAttributes?.[NOT_BEFORE_ATTRIBUTE]?.StringValue)).to.deep.equal([undefined, undefined, undefined, String(1_000_000 + MAX_SQS_DELAY_MS + 1)]);
  });

  it('sends a ScheduleDelay that is not a positive finite number without a delay, and caps an infinite one at the timer limit', async () => {
    const c = await recordingClient({ queue: STANDARD });
    for (const ScheduleDelay of [0, -5, 0.4, Number.NaN, Number.NEGATIVE_INFINITY]) await c.emit(message({ ScheduleDelay }));
    for (const sent of c.sent) {
      expect(sent).to.not.have.property('DelaySeconds');
      expect(sent.MessageAttributes).to.not.have.property(NOT_BEFORE_ATTRIBUTE);
    }

    await c.emit(message({ ScheduleDelay: Number.POSITIVE_INFINITY }));
    expect(c.sent[5].DelaySeconds).to.equal(900);
    expect(c.sent[5].MessageAttributes?.[NOT_BEFORE_ATTRIBUTE]?.StringValue).to.equal(String(1_000_000 + MAX_TIMER_MS));
  });

  it('sends a FIFO message with a ScheduleDelay without the delay', async () => {
    const c = await recordingClient({ queue: FIFO, routing: { OrderPlaced: { groupBy: 'CustomerId' } } });
    await c.emit(message({ CustomerId: 'c-7', ScheduleDelay: 30_000 }));
    await c.emit(message({ CustomerId: 'c-7', ScheduleDelay: 3_600_000 }));
    for (const sent of c.sent) {
      expect(sent).to.not.have.property('DelaySeconds');
      expect(sent.MessageAttributes).to.not.have.property(NOT_BEFORE_ATTRIBUTE);
    }
  });

  it('re-sends a message that is not due yet, without calling the handler', async () => {
    const c = await recordingClient({ queue: STANDARD });
    let called = false;
    await c.receive(STANDARD, message(), {
      attributes: { [NOT_BEFORE_ATTRIBUTE]: String(c.clockMs + 1_200_000) },
      handler: () => {
        called = true;
        return Promise.resolve();
      },
    });
    expect(called).to.equal(false);
    expect(c.sent[0].DelaySeconds).to.equal(900);
    expect(c.sent[0].MessageAttributes?.[NOT_BEFORE_ATTRIBUTE]?.StringValue).to.equal(String(c.clockMs + 1_200_000));
    expect(c.deleted).to.deep.equal(['rh-1']);
  });

  it('keeps the MessageId, traceparent and retry count on the re-sent copy, in the body and in the attributes', async () => {
    const c = await recordingClient({ queue: STANDARD });
    await c.receive(STANDARD, message({ Headers: { [QueueHeaders.TraceParent]: 'tp', [QueueHeaders.RetryCount]: '2' } }), {
      attributes: { [NOT_BEFORE_ATTRIBUTE]: String(c.clockMs + 1_200_000) },
    });
    const body = JSON.parse(c.sent[0].MessageBody ?? '{}') as IQueueMessage;
    expect(body.MessageId).to.equal('m-1');
    expect(body.Headers).to.include({ [QueueHeaders.TraceParent]: 'tp', [QueueHeaders.RetryCount]: '2' });
    expect(readMessageAttributes(c.sent[0].MessageAttributes)).to.include({ [QueueHeaders.MessageId]: 'm-1', [QueueHeaders.TraceParent]: 'tp', [QueueHeaders.RetryCount]: '2' });
  });

  it('re-sends a not-before up to the timer limit, and handles one past it as unreadable', async () => {
    const c = await recordingClient({ queue: STANDARD });
    let calls = 0;
    const handler = () => {
      calls++;
      return Promise.resolve();
    };
    await c.receive(STANDARD, message(), { attributes: { [NOT_BEFORE_ATTRIBUTE]: String(c.clockMs + MAX_TIMER_MS) }, handler });
    expect(calls).to.equal(0);
    expect(c.sent).to.have.length(1);

    for (const notBefore of [String(c.clockMs + MAX_TIMER_MS + 1), '1e20', '1e+300']) {
      await c.receive(STANDARD, message(), { attributes: { [NOT_BEFORE_ATTRIBUTE]: notBefore }, handler });
    }
    expect(calls).to.equal(3);
    expect(c.sent).to.have.length(1);
  });

  it('handles a message whose not-before is due, unreadable, or on a FIFO queue', async () => {
    const c = await recordingClient({ queue: STANDARD });
    let calls = 0;
    const handler = () => {
      calls++;
      return Promise.resolve();
    };
    await c.receive(STANDARD, message(), { attributes: { [NOT_BEFORE_ATTRIBUTE]: String(c.clockMs) }, handler });
    await c.receive(STANDARD, message(), { attributes: { [NOT_BEFORE_ATTRIBUTE]: 'soon' }, handler });
    await c.receive(STANDARD, message(), { attributes: { [NOT_BEFORE_ATTRIBUTE]: 'Infinity' }, handler });
    await c.receive(FIFO, message(), { attributes: { [NOT_BEFORE_ATTRIBUTE]: String(c.clockMs + 1_200_000) }, handler });
    expect(calls).to.equal(4);
    expect(c.sent).to.deep.equal([]);
  });

  it('fills Headers and MessageId from the attributes on receipt, and acks through deleteMessage', async () => {
    const c = await recordingClient({ queue: STANDARD });
    const got: IQueueMessage[] = [];
    await c.receive(STANDARD, message({ MessageId: undefined }), {
      attributes: { [QueueHeaders.MessageId]: 'm-9', [QueueHeaders.TraceParent]: 'tp', custom: 'not a standard header' },
      handler: (m) => {
        got.push(m);
        return Promise.resolve();
      },
    });
    expect(got[0].MessageId).to.equal('m-9');
    expect(got[0].Headers).to.include({ [QueueHeaders.TraceParent]: 'tp', [QueueHeaders.MessageId]: 'm-9' });
    expect(got[0].Headers).to.not.have.property('custom');
    expect(c.deleted).to.deep.equal(['rh-1']);
  });

  it('keeps the body MessageId when the attribute disagrees', async () => {
    const c = await recordingClient({ queue: STANDARD });
    const got: IQueueMessage[] = [];
    await c.receive(STANDARD, message(), {
      attributes: { [QueueHeaders.MessageId]: 'm-x' },
      handler: (m) => {
        got.push(m);
        return Promise.resolve();
      },
    });
    expect(got[0].MessageId).to.equal('m-1');
  });
});
