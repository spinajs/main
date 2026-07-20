/* eslint-disable @typescript-eslint/no-explicit-any */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { IQueueMessage, QueueMessageType } from '@spinajs/queue';
import { DateTime } from 'luxon';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as sinon from 'sinon';
import { AmqpQueueClient } from '../src/connection.js';

chai.use(chaiAsPromised);

/**
 * Minimal in-memory fake of the amqplib parts AmqpQueueClient uses, so the retry / dead-letter /
 * confirm / reconnect logic can be tested deterministically with no broker.
 */
class FakeChannel {
  public asserts: { name: string; opts?: any }[] = [];
  public exchanges: { name: string; type: string; opts?: any }[] = [];
  public binds: { queue: string; exchange: string; key: string }[] = [];
  public published: { exchange: string; routingKey: string; content: Buffer; options: any }[] = [];
  public sent: { queue: string; content: Buffer; options: any }[] = [];
  public consumers = new Map<string, (m: any) => void>();
  public acked: any[] = [];
  public nacked: { msg: any; requeue?: boolean }[] = [];
  public prefetchValue?: number;
  public closed = false;
  public failPublishTimes = 0;
  private tag = 0;

  public async prefetch(n: number) {
    this.prefetchValue = n;
  }
  public async assertQueue(name: string, opts?: any) {
    const q = name || `amq.gen-${++this.tag}`;
    this.asserts.push({ name: q, opts });
    return { queue: q };
  }
  public async assertExchange(name: string, type: string, opts?: any) {
    this.exchanges.push({ name, type, opts });
    return { exchange: name };
  }
  public async bindQueue(queue: string, exchange: string, key: string) {
    this.binds.push({ queue, exchange, key });
  }
  public publish(exchange: string, routingKey: string, content: Buffer, options: any, cb?: (err: any) => void) {
    this.published.push({ exchange, routingKey, content, options });
    if (this.failPublishTimes > 0) {
      this.failPublishTimes--;
      if (cb) cb(new Error('transient publish failure'));
      return true;
    }
    if (cb) cb(null); // broker ack
    return true;
  }
  public sendToQueue(queue: string, content: Buffer, options: any) {
    this.sent.push({ queue, content, options });
    return true;
  }
  public async consume(queue: string, onMsg: (m: any) => void) {
    this.consumers.set(queue, onMsg);
    return { consumerTag: `ct-${++this.tag}` };
  }
  public async cancel() {
    /* noop */
  }
  public ack(msg: any) {
    this.acked.push(msg);
  }
  public nack(msg: any, _allUpTo?: boolean, requeue?: boolean) {
    this.nacked.push({ msg, requeue });
  }
  public async close() {
    this.closed = true;
  }
}

class FakeConnection {
  public handlers = new Map<string, (...a: any[]) => void>();
  public confirmCh = new FakeChannel();
  public plainCh = new FakeChannel();
  public closed = false;
  public on(ev: string, cb: (...a: any[]) => void) {
    this.handlers.set(ev, cb);
  }
  public async createConfirmChannel() {
    return this.confirmCh as any;
  }
  public async createChannel() {
    return this.plainCh as any;
  }
  public async close() {
    this.closed = true;
  }
  public fire(ev: string, ...args: any[]) {
    this.handlers.get(ev)?.(...args);
  }
}

class TestableAmqpClient extends AmqpQueueClient {
  public fake = new FakeConnection();
  protected createConnection(): Promise<any> {
    return Promise.resolve(this.fake);
  }
  public get pub() {
    return this.fake.confirmCh;
  }
  public get con() {
    return this.fake.plainCh;
  }
  public get subsMap() {
    return (this as any).Subscriptions as Map<string, any>;
  }
}

class ConnectionConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      queue: { routing: {} },
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    };
  }
}

function options(extra: Record<string, unknown> = {}) {
  return {
    host: 'localhost',
    name: `amqp-unit-${DateTime.now().toMillis()}-${Math.round(Math.random() * 1e6)}`,
    defaultQueueChannel: '/queue/default',
    defaultTopicChannel: '/topic/default',
    ...extra,
  } as any;
}

async function connected(extra: Record<string, unknown> = {}) {
  const c = new TestableAmqpClient(options(extra));
  await c.resolve();
  return c;
}

function qMessage(extra: Partial<IQueueMessage> = {}): IQueueMessage {
  return { CreatedAt: DateTime.now(), Name: 'TestEvent', Type: QueueMessageType.Event, Persistent: false, Priority: 0, ...extra } as IQueueMessage;
}
function jobMessage(extra: Partial<IQueueMessage> = {}): IQueueMessage {
  return qMessage({ Name: 'TestJob', Type: QueueMessageType.Job, Persistent: true, ...extra });
}
function deliver(ch: FakeChannel, queue: string, body: unknown, headers: Record<string, any> = {}, priority?: number) {
  const onMsg = ch.consumers.get(queue)!;
  onMsg({ content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), properties: { headers, priority }, fields: {} });
}
const tick = () => new Promise<void>((res) => setTimeout(res, 5));

describe('amqp queue transport - unit', function () {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
  });

  describe('connection lifecycle', () => {
    it('creates a confirm channel for publishing and a consume channel with prefetch 1', async () => {
      const c = await connected();
      expect(c.IsConnected).to.be.true;
      expect(c.con.prefetchValue).to.eq(1);
    });

    it('reconnects and replays subscriptions after a connection close', async () => {
      const c = await connected({ reconnectDelay: 10 });
      await c.subscribe('/queue/work', sinon.stub().resolves());
      expect(c.con.consumers.has('/queue/work')).to.be.true;

      c.con.consumers.clear();
      c.fake.fire('close'); // simulate dropped connection
      expect(c.IsConnected).to.be.false;

      await new Promise((r) => setTimeout(r, 40));
      expect(c.IsConnected).to.be.true;
      expect(c.con.consumers.has('/queue/work'), 'subscription should be replayed').to.be.true;
    });
  });

  describe('emit', () => {
    it('publishes a job to the default queue via the confirm channel and resolves on ack', async () => {
      const c = await connected();
      await c.emit(jobMessage({ JobId: 'job-1' } as any));

      const p = c.pub.published.find((x) => x.routingKey === '/queue/default');
      expect(p, 'job published to default queue').to.exist;
      expect(p!.exchange).to.eq('');
      expect(p!.options.persistent).to.eq(true);
      expect(p!.options.contentType).to.eq('application/json');
      expect(p!.options.correlationId).to.eq('job-1');
    });

    it('publishes an event to a fanout exchange', async () => {
      const c = await connected();
      await c.emit(qMessage());

      expect(c.pub.exchanges.find((e) => e.name === '/topic/default' && e.type === 'fanout')).to.exist;
      expect(c.pub.published.find((x) => x.exchange === '/topic/default')).to.exist;
    });

    it('retries emit ( resilience pipeline ) on a transient publish failure', async () => {
      const c = await connected({ retryDelay: 5 });
      c.pub.failPublishTimes = 1; // first publish is nacked, retry should succeed

      await c.emit(jobMessage({ JobId: 'retry-me' } as any));

      const attempts = c.pub.published.filter((p) => p.routingKey === '/queue/default');
      expect(attempts.length, 'publish should have been retried').to.be.greaterThan(1);
    });

    it('buffers emits while disconnected and flushes on reconnect', async () => {
      const c = await connected({ reconnectDelay: 10 });
      c.fake.fire('close');
      expect(c.IsConnected).to.be.false;

      const emitP = c.emit(jobMessage({ JobId: 'buffered' } as any));
      await new Promise((r) => setTimeout(r, 40));
      await emitP;

      expect(c.pub.published.find((x) => x.options.correlationId === 'buffered')).to.exist;
    });
  });

  describe('consume ack / retry / dead-letter', () => {
    it('acks a successfully processed message', async () => {
      const c = await connected();
      await c.subscribe('/queue/work', sinon.stub().resolves());
      deliver(c.con, '/queue/work', jobMessage());
      await tick();
      expect(c.con.acked.length).to.eq(1);
    });

    it('retries a failed job into a TTL retry queue that dead-letters back to the source', async () => {
      const c = await connected({ retryDelay: 100 });
      await c.subscribe('/queue/job', sinon.stub().rejects(new Error('boom')));

      deliver(c.con, '/queue/job', jobMessage({ RetryCount: 3 } as any)); // attempt 0 -> retry 1, delay 100
      await tick();

      const retryQ = '/queue/job.retry.100';
      const asserted = c.con.asserts.find((a) => a.name === retryQ);
      expect(asserted, 'retry queue asserted').to.exist;
      expect(asserted!.opts.arguments['x-message-ttl']).to.eq(100);
      expect(asserted!.opts.arguments['x-dead-letter-routing-key']).to.eq('/queue/job');

      const sent = c.con.sent.find((s) => s.queue === retryQ);
      expect(sent, 'message sent to retry queue').to.exist;
      expect(sent!.options.headers['x-retry-count']).to.eq(1);
      expect(c.con.acked.length).to.eq(1); // original acked
    });

    it('dead-letters a job once retries are exhausted', async () => {
      const c = await connected({ defaultQueueDeadLetterChannel: '/queue/dlq' });
      await c.subscribe('/queue/job', sinon.stub().rejects(new Error('boom')));

      deliver(c.con, '/queue/job', jobMessage({ RetryCount: 2 } as any), { 'x-retry-count': '2' });
      await tick();

      const dl = c.con.sent.find((s) => s.queue === '/queue/dlq');
      expect(dl, 'sent to dead-letter queue').to.exist;
      expect(dl!.options.headers['x-error']).to.contain('boom');
      expect(c.con.acked.length).to.eq(1);
      expect(c.con.sent.some((s) => s.queue.startsWith('/queue/job.retry'))).to.be.false;
    });

    it('drops ( acks ) a job with no dead-letter queue once exhausted', async () => {
      const c = await connected();
      await c.subscribe('/queue/job', sinon.stub().rejects(new Error('boom')));

      deliver(c.con, '/queue/job', jobMessage({ RetryCount: 0 } as any));
      await tick();

      expect(c.con.acked.length).to.eq(1);
      expect(c.con.sent.length).to.eq(0);
      expect(c.con.nacked.length).to.eq(0);
    });

    it('drops ( acks ) a failed EVENT without retry', async () => {
      const c = await connected();
      await c.subscribe('/topic/default', sinon.stub().rejects(new Error('boom')), 'sub-1', true);

      // durable topic subscription consumes from the subscriptionId queue
      const q = [...c.con.consumers.keys()][0];
      deliver(c.con, q, qMessage());
      await tick();

      expect(c.con.acked.length).to.eq(1);
      expect(c.con.sent.length).to.eq(0);
    });

    it('dead-letters an unparseable message instead of leaving it unacked', async () => {
      const c = await connected({ defaultQueueDeadLetterChannel: '/queue/dlq' });
      await c.subscribe('/queue/work', sinon.stub().resolves());

      deliver(c.con, '/queue/work', 'not-json{');
      await tick();

      expect(c.con.sent.find((s) => s.queue === '/queue/dlq')).to.exist;
      expect(c.con.acked.length).to.eq(1);
    });
  });
});
