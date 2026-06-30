/* eslint-disable @typescript-eslint/no-explicit-any */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidArgument, UnexpectedServerError } from '@spinajs/exceptions';
import { IQueueMessage, QueueMessageType } from '@spinajs/queue';
import { DateTime } from 'luxon';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as sinon from 'sinon';
import { StompQueueClient } from '../src/connection.js';

chai.use(chaiAsPromised);

/**
 * Minimal in-memory fake of the parts of `@stomp/stompjs` `Client` that
 * `StompQueueClient` uses. It lets the tests drive the STOMP lifecycle
 * ( connect / error / disconnect / receipt ) deterministically, with no broker.
 */
class FakeStompClient {
  public connected = false;
  public active = false;
  public deactivated = false;

  // lifecycle callbacks set by StompQueueClient
  public onConnect: (frame?: any) => void = () => undefined;
  public onDisconnect: (frame?: any) => void = () => undefined;
  public onStompError: (frame?: any) => void = () => undefined;
  public onWebSocketError: (err?: any) => void = () => undefined;
  public onWebSocketClose: (evt?: any) => void = () => undefined;
  public onUnhandledMessage: (m?: any) => void = () => undefined;
  public beforeConnect: () => void | Promise<void> = () => undefined;
  public debug: (s: string) => void = () => undefined;
  public connectHeaders: any = {};

  // captured interactions
  public published: Array<{ destination: string; body: string; headers: any }> = [];
  public subscriptions: Array<{ destination: string; callback: (m: any) => void; headers: any; id: string; unsubscribe: sinon.SinonStub }> = [];
  public unsubscribed: Array<{ id: string; headers: any }> = [];
  public receiptWatchers = new Map<string, () => void>();

  // when false, broker never confirms publishes ( to test receipt timeout )
  public autoReceipt = true;

  constructor(public config: any) {}

  public activate() {
    this.active = true;
    // connection is driven explicitly from tests via simulateConnect()
  }

  public unsubscribe(id: string, headers?: any) {
    this.unsubscribed.push({ id, headers: headers ?? {} });
  }

  public async deactivate() {
    this.deactivated = true;
    this.connected = false;
    this.active = false;
  }

  public subscribe(destination: string, callback: (m: any) => void, headers: any) {
    const sub = { destination, callback, headers, id: headers?.id ?? `auto-${this.subscriptions.length}`, unsubscribe: sinon.stub() };
    this.subscriptions.push(sub);
    return sub as any;
  }

  public publish(params: { destination: string; body: string; headers?: any }) {
    this.published.push({ destination: params.destination, body: params.body, headers: params.headers ?? {} });

    const receipt = params.headers?.receipt;
    if (receipt && this.autoReceipt && this.receiptWatchers.has(receipt)) {
      // simulate broker RECEIPT frame
      this.receiptWatchers.get(receipt)!();
    }
  }

  public watchForReceipt(receiptId: string, cb: () => void) {
    this.receiptWatchers.set(receiptId, cb);
  }

  // ---- test helpers ----

  public simulateConnect() {
    // mirror stompjs: beforeConnect runs before the connection is announced
    void this.beforeConnect();
    this.connected = true;
    this.active = true;
    this.onConnect({ headers: {}, body: '' });
  }

  public simulateDrop() {
    this.connected = false;
    this.onWebSocketClose({});
  }
}

/**
 * Test subclass that swaps the real stompjs client for the fake via the
 * `createClient` seam and exposes the protected state we assert on.
 */
class TestableStompClient extends StompQueueClient {
  public fake!: FakeStompClient;

  protected createClient(config: any) {
    this.fake = new FakeStompClient(config);
    return this.fake as any;
  }

  public get subs() {
    return (this as any).Subscriptions as Map<string, any>;
  }

  public get pending() {
    return (this as any).PendingEmits as any[];
  }
}

class ConnectionConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      queue: {
        routing: {
          TestEventDurable: '/topic/durable',
          // job whose failures dead-letter to a per-route channel
          RoutedJob: { channel: '/queue/routed-src', deadLetterChannel: '/queue/routed-dlq' },
        },
      },
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    };
  }
}

function options(extra: Record<string, unknown> = {}) {
  return {
    host: 'ws://localhost:61614/ws',
    name: `unit-${DateTime.now().toMillis()}-${Math.round(Math.random() * 1e6)}`,
    defaultQueueChannel: '/queue/default',
    defaultTopicChannel: '/topic/default',
    ...extra,
  } as any;
}

/** Build a client and drive it to the connected state. */
async function connected(extra: Record<string, unknown> = {}) {
  const c = new TestableStompClient(options(extra));
  const p = c.resolve();
  c.fake.simulateConnect();
  await p;
  return c;
}

function qMessage(extra: Partial<IQueueMessage> = {}): IQueueMessage {
  return {
    CreatedAt: DateTime.now(),
    Name: 'TestEvent',
    Type: QueueMessageType.Event,
    Persistent: false,
    Priority: 0,
    ...extra,
  } as IQueueMessage;
}

function brokerMessage(body: unknown, headers: Record<string, string> = {}) {
  return {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
    ack: sinon.stub(),
    nack: sinon.stub(),
  };
}

function jobMessage(extra: Partial<IQueueMessage> = {}): IQueueMessage {
  return qMessage({ Name: 'TestJob', Type: QueueMessageType.Job, ...extra });
}

const tick = () => new Promise<void>((res) => setTimeout(res, 5));

describe('stomp queue transport - unit', function () {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
  });

  describe('resolve / connection lifecycle', () => {
    it('resolves once the broker connects', async () => {
      const c = new TestableStompClient(options());
      const p = c.resolve();
      c.fake.simulateConnect();
      await expect(p).to.be.fulfilled;
    });

    it('rejects and deactivates on STOMP error before first connect', async () => {
      const c = new TestableStompClient(options());
      const p = c.resolve();
      c.fake.onStompError({ headers: { message: 'bad login' }, body: 'nope' });

      await expect(p).to.be.rejectedWith(UnexpectedServerError);
      expect(c.fake.deactivated).to.be.true;
    });

    it('rejects and deactivates on websocket error before first connect', async () => {
      const c = new TestableStompClient(options());
      const p = c.resolve();
      c.fake.onWebSocketError(new Error('refused'));

      await expect(p).to.be.rejectedWith(UnexpectedServerError);
      expect(c.fake.deactivated).to.be.true;
    });

    it('settles only once - a later error does not deactivate an established connection', async () => {
      const c = await connected();

      // a broker error AFTER a successful connect must only be logged
      expect(() => c.fake.onStompError({ headers: { message: 'transient' }, body: '' })).to.not.throw();
      expect(() => c.fake.onWebSocketError(new Error('blip'))).to.not.throw();

      expect(c.fake.deactivated).to.be.false;
    });
  });

  describe('subscribe', () => {
    it('subscribes with client-individual ack and prefetch 1', async () => {
      const c = await connected();
      await c.subscribe('/queue/work', sinon.stub().resolves());

      const sub = c.fake.subscriptions.find((s) => s.destination === '/queue/work');
      expect(sub).to.exist;
      expect(sub!.headers.ack).to.eq('client-individual');
      expect(sub!.headers['activemq.prefetchSize']).to.eq('1');
    });

    it('records a subscription made before connect and applies it on connect', async () => {
      const c = new TestableStompClient(options());

      // subscribe BEFORE the connection is up
      await c.subscribe('/queue/early', sinon.stub().resolves());
      expect(c.subs.has('/queue/early')).to.be.true;
      expect(c.fake?.subscriptions ?? []).to.have.length(0);

      const p = c.resolve();
      c.fake.simulateConnect();
      await p;

      expect(c.fake.subscriptions.some((s) => s.destination === '/queue/early')).to.be.true;
    });

    it('does not subscribe the same channel twice', async () => {
      const c = await connected();
      await c.subscribe('/queue/dup', sinon.stub().resolves());
      await c.subscribe('/queue/dup', sinon.stub().resolves());

      expect(c.fake.subscriptions.filter((s) => s.destination === '/queue/dup')).to.have.length(1);
    });

    it('throws for a durable subscription without a subscription id', async () => {
      const c = await connected();
      await expect(c.subscribe('/topic/durable', sinon.stub().resolves(), undefined, true)).to.be.rejectedWith(InvalidArgument);
    });

    it('sets activemq.subscriptionName for durable subscriptions', async () => {
      const c = await connected();
      await c.subscribe('/topic/durable', sinon.stub().resolves(), 'sub-1', true);

      const sub = c.fake.subscriptions.find((s) => s.destination === '/topic/durable');
      expect(sub!.headers['activemq.subscriptionName']).to.eq('sub-1');
      expect(sub!.headers.id).to.eq('sub-1');
    });
  });

  describe('reconnect', () => {
    it('replays all tracked subscriptions after a reconnect', async () => {
      const c = await connected();
      await c.subscribe('/queue/a', sinon.stub().resolves());
      await c.subscribe('/queue/b', sinon.stub().resolves());

      expect(c.fake.subscriptions).to.have.length(2);

      // socket drops, then comes back ( stompjs would auto-reconnect )
      c.fake.simulateDrop();
      c.fake.simulateConnect();

      // both subscriptions must be re-created on the new connection
      expect(c.fake.subscriptions.filter((s) => s.destination === '/queue/a')).to.have.length(2);
      expect(c.fake.subscriptions.filter((s) => s.destination === '/queue/b')).to.have.length(2);
    });
  });

  describe('emit', () => {
    it('publishes to the routed channel and resolves on broker receipt', async () => {
      const c = await connected();
      await c.emit(qMessage({ Name: 'TestEvent' }));

      expect(c.fake.published).to.have.length(1);
      expect(c.fake.published[0].destination).to.eq('/topic/default');
    });

    it('maps message metadata to STOMP headers', async () => {
      const c = await connected();
      await c.emit(
        qMessage({
          Type: QueueMessageType.Job,
          Persistent: true,
          Priority: 5,
          ScheduleDelay: 1000,
          ScheduleRepeat: 3,
          SchedulePeriod: 500,
          ScheduleCron: '* * * * *',
        }),
      );

      const h = c.fake.published[0].headers;
      expect(h.persistent).to.eq('true');
      expect(h.priority).to.eq('5');
      expect(h.AMQ_SCHEDULED_DELAY).to.eq('1000');
      expect(h.AMQ_SCHEDULED_REPEAT).to.eq('3');
      expect(h.AMQ_SCHEDULED_PERIOD).to.eq('500');
      expect(h.AMQ_SCHEDULED_CRON).to.eq('* * * * *');
      expect(h.receipt).to.be.a('string');
    });

    it('buffers messages emitted while disconnected and flushes them on connect', async () => {
      const c = new TestableStompClient(options());

      const emitP = c.emit(qMessage());
      expect(c.pending).to.have.length(1);
      expect(c.fake?.published ?? []).to.have.length(0);

      const p = c.resolve();
      c.fake.simulateConnect();
      await p;
      await emitP;

      expect(c.pending).to.have.length(0);
      expect(c.fake.published).to.have.length(1);
    });

    it('rejects when the broker never confirms the publish ( receipt timeout )', async () => {
      const c = await connected({ options: { receiptTimeout: 30 } });
      c.fake.autoReceipt = false;

      await expect(c.emit(qMessage())).to.be.rejectedWith(UnexpectedServerError, /receipt/i);
    });
  });

  describe('message handling / ack', () => {
    it('acks a message after the handler succeeds', async () => {
      const c = await connected();
      const handler = sinon.stub().resolves();
      await c.subscribe('/queue/ok', handler);

      const sub = c.fake.subscriptions.find((s) => s.destination === '/queue/ok')!;
      const msg = brokerMessage(qMessage());
      sub.callback(msg);
      await tick();

      expect(handler.calledOnce).to.be.true;
      expect(msg.ack.calledOnce).to.be.true;
      expect(msg.nack.called).to.be.false;
    });

    it('drops ( acks ) a failed EVENT - events are not retried or dead-lettered', async () => {
      const c = await connected({ defaultQueueDeadLetterChannel: '/queue/dlq' });
      await c.subscribe('/topic/evt', sinon.stub().rejects(new Error('boom')));

      const sub = c.fake.subscriptions.find((s) => s.destination === '/topic/evt')!;
      const msg = brokerMessage(qMessage({ Type: QueueMessageType.Event }));
      sub.callback(msg);
      await tick();

      expect(msg.ack.calledOnce).to.be.true;
      expect(msg.nack.called).to.be.false;
      expect(c.fake.published.some((p) => p.destination === '/queue/dlq')).to.be.false;
    });

    it('nacks a failed JOB when no dead-letter channel is configured', async () => {
      const c = await connected();
      await c.subscribe('/queue/fail', sinon.stub().rejects(new Error('boom')));

      const sub = c.fake.subscriptions.find((s) => s.destination === '/queue/fail')!;
      const msg = brokerMessage(jobMessage()); // RetryCount undefined -> 0 -> straight to DLQ logic
      sub.callback(msg);
      await tick();

      expect(msg.nack.calledOnce).to.be.true;
      expect(msg.ack.called).to.be.false;
    });

    it('dead-letters a failed JOB ( RetryCount 0 ) and acks the original', async () => {
      const c = await connected({ defaultQueueDeadLetterChannel: '/queue/dlq' });
      await c.subscribe('/queue/fail', sinon.stub().rejects(new Error('boom')));

      const sub = c.fake.subscriptions.find((s) => s.destination === '/queue/fail')!;
      const msg = brokerMessage(jobMessage({ Name: 'FailingJob' }));
      sub.callback(msg);
      await tick();

      expect(msg.ack.calledOnce).to.be.true;
      expect(msg.nack.called).to.be.false;

      const dlq = c.fake.published.find((p) => p.destination === '/queue/dlq');
      expect(dlq, 'message should be published to dead-letter channel').to.exist;
      expect(dlq!.headers['x-original-destination']).to.eq('/queue/fail');
      expect(dlq!.headers['x-error']).to.eq('boom');
    });

    it('prefers the per-route deadLetterChannel over the connection default', async () => {
      const c = await connected({ defaultQueueDeadLetterChannel: '/queue/conn-dlq' });
      await c.subscribe('/queue/routed-src', sinon.stub().rejects(new Error('boom')));

      const sub = c.fake.subscriptions.find((s) => s.destination === '/queue/routed-src')!;
      // Name 'RoutedJob' maps in routing to deadLetterChannel '/queue/routed-dlq'
      const msg = brokerMessage(jobMessage({ Name: 'RoutedJob' }));
      sub.callback(msg);
      await tick();

      expect(c.fake.published.some((p) => p.destination === '/queue/routed-dlq')).to.be.true;
      expect(c.fake.published.some((p) => p.destination === '/queue/conn-dlq')).to.be.false;
    });

    it('dead-letters a message with an unparseable body instead of leaving it unacked', async () => {
      const c = await connected({ defaultQueueDeadLetterChannel: '/queue/dlq' });
      await c.subscribe('/queue/bad', sinon.stub().resolves());

      const sub = c.fake.subscriptions.find((s) => s.destination === '/queue/bad')!;
      const msg = brokerMessage('not-json{');
      sub.callback(msg);
      await tick();

      expect(msg.ack.calledOnce).to.be.true;
      expect(c.fake.published.some((p) => p.destination === '/queue/dlq')).to.be.true;
    });
  });

  describe('job retry ( RetryCount )', () => {
    it('reschedules a failed job to the same channel with an incremented retry header', async () => {
      const c = await connected();
      await c.subscribe('/queue/job', sinon.stub().rejects(new Error('boom')));

      const sub = c.fake.subscriptions.find((s) => s.destination === '/queue/job')!;
      const msg = brokerMessage(jobMessage({ RetryCount: 2 } as any)); // attempt 0
      sub.callback(msg);
      await tick();

      expect(msg.ack.calledOnce).to.be.true; // original acked, retry republished
      const retry = c.fake.published.find((p) => p.destination === '/queue/job');
      expect(retry, 'job should be re-published to the same channel').to.exist;
      expect(retry!.headers['x-retry-count']).to.eq('1');
    });

    it('applies exponential backoff via AMQ_SCHEDULED_DELAY when retryDelay is set', async () => {
      const c = await connected({ retryDelay: 100 });
      await c.subscribe('/queue/job', sinon.stub().rejects(new Error('boom')));

      const sub = c.fake.subscriptions.find((s) => s.destination === '/queue/job')!;
      // already retried once -> next attempt is 2 -> delay = 100 * 2^(2-1) = 200
      const msg = brokerMessage(jobMessage({ RetryCount: 3 } as any), { 'x-retry-count': '1' });
      sub.callback(msg);
      await tick();

      const retry = c.fake.published.find((p) => p.destination === '/queue/job');
      expect(retry!.headers['x-retry-count']).to.eq('2');
      expect(retry!.headers.AMQ_SCHEDULED_DELAY).to.eq('200');
    });

    it('dead-letters the job once retries are exhausted', async () => {
      const c = await connected({ defaultQueueDeadLetterChannel: '/queue/dlq' });
      await c.subscribe('/queue/job', sinon.stub().rejects(new Error('boom')));

      const sub = c.fake.subscriptions.find((s) => s.destination === '/queue/job')!;
      // attempt already at the limit -> no more retries -> DLQ
      const msg = brokerMessage(jobMessage({ RetryCount: 2 } as any), { 'x-retry-count': '2' });
      sub.callback(msg);
      await tick();

      expect(msg.ack.calledOnce).to.be.true;
      const dlq = c.fake.published.find((p) => p.destination === '/queue/dlq');
      expect(dlq).to.exist;
      expect(dlq!.headers['x-retry-count']).to.eq('2');
      // not re-published to the source channel
      expect(c.fake.published.some((p) => p.destination === '/queue/job')).to.be.false;
    });
  });

  describe('publish headers ( content-type / correlation-id )', () => {
    it('sets content-type application/json on every publish', async () => {
      const c = await connected();
      await c.emit(qMessage());
      expect(c.fake.published[0].headers['content-type']).to.eq('application/json');
    });

    it('sets correlation-id to the JobId for jobs, and omits it for events', async () => {
      const c = await connected();

      await c.emit(jobMessage({ JobId: 'job-123' } as any));
      await c.emit(qMessage()); // event, no JobId

      const job = c.fake.published.find((p) => p.headers['correlation-id']);
      expect(job!.headers['correlation-id']).to.eq('job-123');

      const evt = c.fake.published.find((p) => p.destination === '/topic/default');
      expect(evt!.headers['correlation-id']).to.be.undefined;
    });
  });

  describe('CreatedAt fidelity', () => {
    it('rehydrates a string CreatedAt into a luxon DateTime before the handler runs', async () => {
      const c = await connected();
      const handler = sinon.stub().resolves();
      await c.subscribe('/queue/dt', handler);

      const sub = c.fake.subscriptions.find((s) => s.destination === '/queue/dt')!;
      // serialize a message ( CreatedAt becomes an ISO string on the wire )
      const msg = brokerMessage(JSON.stringify(qMessage()));
      sub.callback(msg);
      await tick();

      const received = handler.firstCall.args[0];
      expect(DateTime.isDateTime(received.CreatedAt)).to.be.true;
    });
  });

  describe('unsubscribe', () => {
    it('unsubscribes the live subscription and forgets the descriptor', async () => {
      const c = await connected();
      await c.subscribe('/queue/x', sinon.stub().resolves());
      const sub = c.fake.subscriptions.find((s) => s.destination === '/queue/x')!;

      c.unsubscribe('/queue/x');

      expect(sub.unsubscribe.calledOnce).to.be.true;
      expect(c.subs.has('/queue/x')).to.be.false;
    });

    it('does not replay an unsubscribed channel after reconnect', async () => {
      const c = await connected();
      await c.subscribe('/queue/x', sinon.stub().resolves());
      c.unsubscribe('/queue/x');

      c.fake.simulateDrop();
      c.fake.simulateConnect();

      expect(c.fake.subscriptions.filter((s) => s.destination === '/queue/x')).to.have.length(1);
    });

    it('removes the broker-side durable subscription when removeDurable is set', async () => {
      const c = await connected();
      await c.subscribe('/topic/durable', sinon.stub().resolves(), 'sub-1', true);

      c.unsubscribe('/topic/durable', true);

      expect(c.fake.unsubscribed).to.have.length(1);
      expect(c.fake.unsubscribed[0].id).to.eq('sub-1');
      expect(c.fake.unsubscribed[0].headers['activemq.subscriptionName']).to.eq('sub-1');
      expect(c.subs.has('/topic/durable')).to.be.false;
    });
  });

  describe('readiness', () => {
    it('Connected reflects the live connection state', async () => {
      const c = new TestableStompClient(options());
      const p = c.resolve();
      expect(c.Connected).to.be.false;
      c.fake.simulateConnect();
      await p;
      expect(c.Connected).to.be.true;
    });

    it('whenReady resolves on ( re )connect and immediately when already connected', async () => {
      const c = new TestableStompClient(options());

      const readyP = c.whenReady();
      const resolvedEarly = c.resolve();
      c.fake.simulateConnect();
      await resolvedEarly;
      await expect(readyP).to.be.fulfilled;

      // already connected -> resolves immediately
      await expect(c.whenReady()).to.be.fulfilled;
    });
  });

  describe('credentials / unhandled messages', () => {
    it('refreshes credentials via the configured provider before connecting', async () => {
      DI.register(
        class {
          public getCredentials() {
            return Promise.resolve({ login: 'dynamic-user', passcode: 'dynamic-pass' });
          }
        },
      ).as('TestCredProvider');

      const c = new TestableStompClient(options({ credentialProvider: 'TestCredProvider' }));
      const p = c.resolve();
      c.fake.simulateConnect();
      await p;
      await tick();

      expect(c.fake.connectHeaders.login).to.eq('dynamic-user');
      expect(c.fake.connectHeaders.passcode).to.eq('dynamic-pass');
    });

    it('logs unhandled messages without throwing', async () => {
      const c = await connected();
      expect(() => c.fake.onUnhandledMessage({ headers: { destination: '/topic/stray' }, body: 'hi' })).to.not.throw();
    });
  });

  describe('dispose', () => {
    it('deactivates the client', async () => {
      const c = await connected();
      await c.dispose();
      expect(c.fake.deactivated).to.be.true;
    });

    it('rejects emits that are still buffered at dispose time', async () => {
      const c = new TestableStompClient(options());
      const emitP = c.emit(qMessage()); // buffered - never connected
      await c.dispose();

      await expect(emitP).to.be.rejectedWith(UnexpectedServerError);
    });
  });
});
