import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { AmqpQueueClient } from '../src/connection.js';
import _ from 'lodash';
import { join, normalize, resolve } from 'path';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { QueueMessageType } from '@spinajs/queue';
import { DateTime } from 'luxon';
import * as sinon from 'sinon';

chai.use(chaiAsPromised);

// queues/exchanges are durable on the broker, so use a per-run suffix to keep test runs isolated
// from each other ( and from leftovers of previous runs against a long-lived broker ).
const RUN = DateTime.now().toMillis();
const TestEventChannelName = `/topic/test-${RUN}`;
const TestJobChannelName = `/queue/test-${RUN}`;
const DurableTopicChannel = `/topic/durable-${RUN}`;
const RoutedTopicChannel = `/topic/routed-${RUN}`;
const RoutedJobChannel = `/queue/routed-${RUN}`;
const QUEUE_WAIT_TIME_MS = 1000;

const AMQP_HOST = process.env.AMQP_HOST ?? 'localhost';
const AMQP_PORT = process.env.AMQP_PORT ? parseInt(process.env.AMQP_PORT, 10) : 5672;

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

async function wait(amount: number) {
  return new Promise<void>((res) => {
    setTimeout(() => {
      res();
    }, amount);
  });
}

export class ConnectionConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      queue: {
        routing: {
          TestEventDurable: DurableTopicChannel,
          TestEventRouted: RoutedTopicChannel,
          TestJobRouted: RoutedJobChannel,
        },
      },
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
            layout: '${datetime} ${level} ${message} ${error} duration: ${duration} ms (${logger})',
          },
        ],

        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    };
  }
}

const qList: AmqpQueueClient[] = [];

async function q() {
  const q = await DI.resolve(AmqpQueueClient, [
    {
      host: AMQP_HOST,
      port: AMQP_PORT,
      name: `test-id-${DateTime.now().toMillis()}`,
      defaultQueueChannel: TestJobChannelName,
      defaultTopicChannel: TestEventChannelName,
      // raise prefetch so the high-volume throughput tests finish within the mocha timeout
      options: { prefetch: 50 },
    },
  ]);

  qList.push(q);

  return q;
}

describe('amqp queue transport test', function () {
  this.timeout(20000);

  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);

    await DI.resolve(Configuration);
  });

  afterEach(async () => {
    for (const q of qList) {
      await q.dispose();
    }
    qList.length = 0;
  });

  after(() => {
    process.exit(0);
  });

  it('Should connect to queue server', async () => {
    await q();
  });

  it('Should throw when cannot connect to server', async () => {
    const p = DI.resolve(AmqpQueueClient, [
      {
        host: AMQP_HOST,
        port: 1, // nothing listening here
        name: 'test-id-bad',
      },
    ]);

    await expect(p).to.be.rejected;
  });

  it('Should emit job', async () => {
    const c = await q();

    const message = {
      CreatedAt: DateTime.now(),
      Name: 'TestJob',
      Type: QueueMessageType.Job,
      Foo: 'bar',
      Persistent: false,
      Priority: 0,
    };

    const s = sinon.stub().returns(Promise.resolve());

    await c.subscribe(TestJobChannelName, s);
    await c.emit(message);

    await wait(QUEUE_WAIT_TIME_MS);

    expect(s.calledOnce).to.be.true;
  });

  it('Should emit event', async () => {
    const c = await q();

    const message = {
      CreatedAt: DateTime.now(),
      Name: 'TestEvent',
      Type: QueueMessageType.Event,
      Foo: 'far',
      Persistent: false,
      Priority: 0,
    };

    const s = sinon.stub().returns(Promise.resolve());

    await c.subscribe(TestEventChannelName, s);
    await c.emit(message);

    await wait(QUEUE_WAIT_TIME_MS);

    expect(s.calledOnce).to.be.true;
  });

  it('Should emit multiple events', async () => {
    const c = await q();

    const message = {
      CreatedAt: DateTime.now(),
      Name: 'TestEvent',
      Type: QueueMessageType.Event,
      Foo: 'far',
      Persistent: false,
      Priority: 0,
    };

    const s = sinon.stub().returns(Promise.resolve());

    await c.subscribe(TestEventChannelName, s);
    await c.emit(message);
    await c.emit(message);
    await c.emit(message);

    await wait(QUEUE_WAIT_TIME_MS);

    expect(s.calledThrice).to.be.true;
  });

  it('Should emit durable event', async () => {
    const c = await q();

    const message = {
      CreatedAt: DateTime.now(),
      Name: 'TestEventDurable',
      Type: QueueMessageType.Event,
      Foo: 'far',
      Persistent: true,
      Priority: 0,
    };

    const s = sinon.stub().returns(Promise.resolve());

    await c.subscribe(DurableTopicChannel, s, `test-durable-${RUN}`, true);
    await c.emit(message);

    await wait(QUEUE_WAIT_TIME_MS);

    expect(s.calledOnce).to.be.true;
    c.unsubscribe(DurableTopicChannel);

    await wait(QUEUE_WAIT_TIME_MS);

    await c.emit(message);

    await wait(QUEUE_WAIT_TIME_MS);

    expect(s.calledOnce).to.be.true;

    await c.subscribe(DurableTopicChannel, s, `test-durable-${RUN}`, true);

    await wait(QUEUE_WAIT_TIME_MS);

    expect(s.calledTwice).to.be.true;
  });

  it('Should register on job multiple subscribers', async () => {
    const c1 = await q();
    const c2 = await q();

    const message = {
      CreatedAt: DateTime.now(),
      Name: 'TestJob',
      Type: QueueMessageType.Job,
      Foo: 'far',
      Persistent: false,
      Priority: 0,
    };

    const s1 = sinon.stub().returns(Promise.resolve());
    const s2 = sinon.stub().returns(Promise.resolve());

    await c1.subscribe(TestJobChannelName, s1);
    await c2.subscribe(TestJobChannelName, s2);

    for (let i = 0; i < 500; i++) {
      await c1.emit(message);
    }

    await wait(QUEUE_WAIT_TIME_MS * 3);

    expect(s1.callCount + s2.callCount).to.eq(500);
  });

  it('Should register on event multiple subscribers', async () => {
    const c1 = await q();
    const c2 = await q();

    const message = {
      CreatedAt: DateTime.now(),
      Name: 'TestEvent',
      Type: QueueMessageType.Event,
      Foo: 'far',
      Persistent: false,
      Priority: 0,
    };

    const s1 = sinon.stub().returns(Promise.resolve());
    const s2 = sinon.stub().returns(Promise.resolve());

    await c1.subscribe(TestEventChannelName, s1);
    await c2.subscribe(TestEventChannelName, s2);

    await wait(QUEUE_WAIT_TIME_MS);

    await c1.emit(message);

    await wait(QUEUE_WAIT_TIME_MS);

    expect(s1.calledOnce).to.be.true;
    expect(s2.calledOnce).to.be.true;
  });

  it('Should route job with routing table', async () => {
    const c1 = await q();

    const message = {
      CreatedAt: DateTime.now(),
      Name: 'TestJobRouted',
      Type: QueueMessageType.Job,
      Foo: 'far',
      Persistent: false,
      Priority: 0,
    };

    const s1 = sinon.stub().returns(Promise.resolve());

    await c1.subscribe(RoutedJobChannel, s1);

    for (let i = 0; i < 500; i++) {
      await c1.emit(message);
    }

    await wait(QUEUE_WAIT_TIME_MS * 3);

    expect(s1.callCount).to.eq(500);
  });

  it('Should route event with routing table', async () => {
    const c = await q();

    const message = {
      CreatedAt: DateTime.now(),
      Name: 'TestEventRouted',
      Type: QueueMessageType.Event,
      Foo: 'far',
      Persistent: false,
      Priority: 0,
    };

    const s = sinon.stub().returns(Promise.resolve());

    await c.subscribe(RoutedTopicChannel, s);
    await c.emit(message);
    await c.emit(message);
    await c.emit(message);

    await wait(QUEUE_WAIT_TIME_MS);

    expect(s.calledThrice).to.be.true;
  });

  it('Should unsubscribe', async () => {
    const c = await q();

    const message = {
      CreatedAt: DateTime.now(),
      Name: 'TestEvent',
      Type: QueueMessageType.Event,
      Foo: 'far',
      Persistent: false,
      Priority: 0,
    };

    const s = sinon.stub().returns(Promise.resolve());

    await c.subscribe(TestEventChannelName, s);
    await c.emit(message);
    await c.emit(message);

    await wait(QUEUE_WAIT_TIME_MS);

    c.unsubscribe(TestEventChannelName);

    await wait(QUEUE_WAIT_TIME_MS);

    await c.emit(message);
    await wait(QUEUE_WAIT_TIME_MS);

    expect(s.calledTwice).to.be.true;
  });
});
