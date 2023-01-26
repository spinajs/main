import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { StompQueueClient } from '../src/index.js';
import _ from 'lodash';
import { join, normalize, resolve } from 'path';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { QueueMessageType } from '@spinajs/queue';
import { DateTime } from 'luxon';
import * as sinon from 'sinon';

chai.use(chaiAsPromised);

const TestEventChannelName = `/topic/test-${DateTime.now().toMillis()}`;
const TestJobChannelName = `/queue/test-${DateTime.now().toMillis()}`;
const QUEUE_WAIT_TIME_MS = 1000;

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

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
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        queue: {
          routing: {
            TestEventDurable: '/topic/durable',
            TestEventRouted: '/topic/routed',
            TestJobRouted: '/queue/routed',
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
      },
      mergeArrays,
    );
  }
}

const qList: StompQueueClient[] = [];

async function q() {
  const q = await DI.resolve(StompQueueClient, [
    {
      host: 'ws://localhost:61614/ws',
      name: `test-id-${DateTime.now().toMillis()}`,
      debug: true,
      defaultQueueChannel: TestJobChannelName,
      defaultTopicChannel: TestEventChannelName,
    },
  ]);

  qList.push(q);

  return q;
}

describe('stomp queue transport test', function () {
  this.timeout(20000);

  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);

    await DI.resolve(Configuration);
  });

  afterEach(async () => {
    for (const q of qList) {
      q.dispose();
    }
  });

  after(() => {
    process.exit(0);
  });

  it('Should connect to queue server', async () => {
    await q();
  });

  it('Should throw when cannot connect to server', async () => {
    const p = DI.resolve(StompQueueClient, [
      {
        host: 'ws://localhost:61615/ws',
        name: 'test-id',
        debug: true,
      },
    ]);

    expect(p).to.be.rejected;
  });

  it('Should emit job', async () => {
    const c = await q();

    const message = {
      CreatedAt: DateTime.now(),
      Name: 'TestJob',
      Type: QueueMessageType.Job,
      Foo: 'bar',
    };

    const s = sinon.stub().returns(Promise.resolve());

    c.subscribe(TestJobChannelName, s);
    c.emit(message);

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
    };

    const s = sinon.stub().returns(Promise.resolve());

    c.subscribe(TestEventChannelName, s);
    c.emit(message);

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
    };

    const s = sinon.stub().returns(Promise.resolve());

    c.subscribe(TestEventChannelName, s);
    c.emit(message);
    c.emit(message);
    c.emit(message);

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
    };

    const s = sinon.stub().returns(Promise.resolve());

    c.subscribe('/topic/durable', s, 'test-durable', true);
    c.emit(message);

    await wait(QUEUE_WAIT_TIME_MS);

    expect(s.calledOnce).to.be.true;
    c.unsubscribe('/topic/durable');

    c.emit(message);

    await wait(QUEUE_WAIT_TIME_MS);

    expect(s.calledOnce).to.be.true;

    c.subscribe('/topic/durable', s, 'test-durable', true);

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
    };

    const s1 = sinon.stub().returns(Promise.resolve());
    const s2 = sinon.stub().returns(Promise.resolve());

    c1.subscribe(TestJobChannelName, s1);
    c2.subscribe(TestJobChannelName, s2);

    for (let i = 0; i < 500; i++) {
      c1.emit(message);
    }

    await wait(QUEUE_WAIT_TIME_MS * 2);

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
    };

    const s1 = sinon.stub().returns(Promise.resolve());
    const s2 = sinon.stub().returns(Promise.resolve());

    c1.subscribe(TestEventChannelName, s1);
    c2.subscribe(TestEventChannelName, s2);

    await wait(QUEUE_WAIT_TIME_MS);

    c1.emit(message);

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
    };

    const s1 = sinon.stub().returns(Promise.resolve());

    c1.subscribe('/queue/routed', s1);

    for (let i = 0; i < 500; i++) {
      c1.emit(message);
    }

    await wait(QUEUE_WAIT_TIME_MS * 2);

    expect(s1.callCount).to.eq(500);
  });

  it('Should route event with routing table', async () => {
    const c = await q();

    const message = {
      CreatedAt: DateTime.now(),
      Name: 'TestEventRouted',
      Type: QueueMessageType.Event,
      Foo: 'far',
    };

    const s = sinon.stub().returns(Promise.resolve());

    c.subscribe('/topic/routed', s);
    c.emit(message);
    c.emit(message);
    c.emit(message);

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
    };

    const s = sinon.stub().returns(Promise.resolve());

    c.subscribe(TestEventChannelName, s);
    c.emit(message);
    c.emit(message);

    await wait(QUEUE_WAIT_TIME_MS);

    c.unsubscribe(TestEventChannelName);
    c.emit(message);
    await wait(QUEUE_WAIT_TIME_MS);

    expect(s.calledTwice).to.be.true;
  });

  it('Should execute with delay', async () => {
    const c = await q();
    const s = sinon.stub().returns(Promise.resolve());

    const message = {
      CreatedAt: DateTime.now(),
      Name: 'TestEvent',
      Type: QueueMessageType.Event,
      Foo: 'far',
      ScheduleDelay: 5000,
    };

    c.subscribe(TestEventChannelName, s);
    c.emit(message);

    await wait(QUEUE_WAIT_TIME_MS);

    expect(s.calledOnce).to.be.false;

    await wait(QUEUE_WAIT_TIME_MS * 5);

    expect(s.calledOnce).to.be.true;
  });

  it('Should execute 10 times', async () => {
    const c = await q();
    const s = sinon.stub().returns(Promise.resolve());

    const message = {
      CreatedAt: DateTime.now(),
      Name: 'TestEvent',
      Type: QueueMessageType.Event,
      Foo: 'far',
      ScheduleDelay: 1000,
      ScheduleRepeat: 10,
      SchedulePeriod: 1000,
    };

    c.subscribe(TestEventChannelName, s);
    c.emit(message);

    await wait(QUEUE_WAIT_TIME_MS);

    expect(s.calledOnce).to.be.false;

    await wait(QUEUE_WAIT_TIME_MS * 15);

    expect(s.callCount).to.eq(11);
  });
});
