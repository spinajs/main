import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import * as _ from 'lodash';
import { join, normalize, resolve } from 'path';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { QueueEvent, QueueJob, Event, Job, QueueService, JobModel } from './../src';
import { DateTime } from 'luxon';
import { expect } from 'chai';
import '@spinajs/orm-sqlite';
import * as sinon from 'sinon';

import '@spinajs/queue-stomp-transport';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';

chai.use(chaiAsPromised);

const TestEventChannelName = `/topic/test-${DateTime.now().toMillis()}`;
const TestJobChannelName = `/queue/test-${DateTime.now().toMillis()}`;
const QUEUE_WAIT_TIME_MS = 5 * 1000;

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

export function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

async function wait(amount?: number) {
  return new Promise<void>((res) => {
    setTimeout(() => {
      res();
    }, amount ?? QUEUE_WAIT_TIME_MS);
  });
}

export class ConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        system: {
          dirs: {
            migrations: [dir('./../src/migrations')],
            models: [dir('./../src/models')],
          },
        },
        db: {
          DefaultConnection: 'sqlite',
          Connections: [
            // queue DB
            {
              Driver: 'orm-driver-sqlite',
              Filename: ':memory:',
              Name: 'queue',
              Migration: {
                OnStartup: true,
                Table: 'orm_migrations',
                Transaction: {
                  Mode: MigrationTransactionMode.PerMigration,
                },
              },
            },

            // default connection
            {
              Driver: 'orm-driver-sqlite',
              Filename: ':memory:',
              Name: 'sqlite',
              Migration: {
                OnStartup: true,
                Table: 'orm_migrations',
                Transaction: {
                  Mode: MigrationTransactionMode.PerMigration,
                },
              },
            },
          ],
        },
        queue: {
          default: 'default-test-queue',
          connections: [
            {
              transport: 'StompQueueClient',
              host: 'ws://localhost:61614/ws',
              name: `default-test-queue`,
              debug: true,
              defaultQueueChannel: TestJobChannelName,
              defaultTopicChannel: TestEventChannelName,
              messageRouting: {
                TestEventDurable: '/topic/durable',
                TestEventRouted: '/topic/routed',
                TestJobRouted: '/queue/routed',
              },
            },
          ],
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

@Event()
class SampleEvent extends QueueEvent {
  Bar: string;
}

@Event()
class SampleEvent2 extends QueueEvent {
  Bar: string;
}

@Event({
  durable: true,
})
class DurableEvent extends QueueEvent {
  Bar: string;
}

@Job()
class SampleJob extends QueueJob {
  public Foo: string;

  public async execute(progress: (p: number) => Promise<void>) {
    await progress(0);

    await wait(500);

    await progress(50);

    await wait(500);

    await progress(100);

    return 'finished';
  }
}

async function q() {
  return DI.resolve(QueueService);
}

describe('jobs', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);

    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    sinon.restore();

    const queue = await q();

    await queue.dispose();
  });

  it('should connecto to queue server', async () => {
    const queue = await q();

    const c = await queue.get();
    expect(c).to.be.not.null;
  });
  it('should subscribe to jobs', async () => {
    const queue = await q();
    const sExecute = sinon.spy(SampleJob.prototype, 'execute');

    await queue.consume(SampleJob);

    await SampleJob.emit({ Foo: 'test job' });
    await wait(QUEUE_WAIT_TIME_MS);

    expect(sExecute.calledOnce).to.be.true;
    expect((sExecute.thisValues[0] as SampleJob).Foo).to.eq('test job');
  });

  it('should subscribe to events', async () => {
    const queue = await q();
    const callback = sinon.stub().returns(Promise.resolve());

    await queue.consume(SampleEvent, callback);

    SampleEvent.emit({ Bar: 'test message' });

    await wait(QUEUE_WAIT_TIME_MS);

    expect(callback.calledOnce).to.be.true;
    expect((callback.args[0][0] as any).Bar).to.eq('test message');
  });

  it('should subscribe to durable events', async () => {
    const queue = await q();
    const callback = sinon.stub().returns(Promise.resolve());

    await queue.consume(DurableEvent, callback, 'test-durable');

    DurableEvent.emit({ Bar: 'test message' });

    await wait(QUEUE_WAIT_TIME_MS);

    expect(callback.calledOnce).to.be.true;
    expect((callback.args[0][0] as any).Bar).to.eq('test message');

    await queue.stopConsuming(DurableEvent);

    DurableEvent.emit({ Bar: 'test message' });

    await wait(QUEUE_WAIT_TIME_MS);

    expect(callback.calledOnce).to.be.true;

    await queue.consume(DurableEvent, callback, 'test-durable');
    await wait(QUEUE_WAIT_TIME_MS);
    expect(callback.calledTwice).to.be.true;
  });

  // NOTE: stomp with topics, when we send nack, treats message as dequeued already
  // ACK/NACK works only with Queues ????
  // it('should retry durable event on error', async () => {
  //   const queue = await q();
  //   const callback = sinon.stub().onFirstCall().rejects('first call rejected').onSecondCall().resolves();

  //   await queue.consume(DurableEvent, callback, 'test-durable');

  //   DurableEvent.emit({ Bar: 'test message' });

  //   await wait(10 * 1000);

  //   DurableEvent.emit({ Bar: 'test message' });

  //   await wait(10 * 1000);

  //   expect(callback.calledTwice).to.be.true;
  //   expect((callback.args[0][0] as any).Bar).to.eq('test message');
  // });

  it('Should preserve job result', async () => {
    const queue = await q();
    const sExecute = sinon.spy(SampleJob.prototype, 'execute');

    await queue.consume(SampleJob);

    await SampleJob.emit({ Foo: 'test job' });
    await wait(10 * 1000);

    expect(sExecute.calledOnce).to.be.true;

    const job = sExecute.thisValues[0] as SampleJob;

    expect(job).to.be.instanceOf(SampleJob);
    expect(job.JobId).to.be.not.null;
    expect(job.Foo).to.equal('test job');

    const model = await JobModel.where('JobId', job.JobId).first();

    expect(model).to.be.not.null;

    expect(model.Result).to.eq('finished');
    expect(model.Progress).to.eq(100);
  });

  it('Should filter out event we dont subscribe to', async () => {
    const queue = await q();
    const callback = sinon.stub().returns(Promise.resolve());

    await queue.consume(SampleEvent2, callback);

    SampleEvent.emit({ Bar: 'test message' });
    SampleEvent2.emit({ Bar: 'test message' });

    await wait(QUEUE_WAIT_TIME_MS);

    expect(callback.calledOnce).to.be.true;
    expect((callback.args[0][0] as any).Bar).to.eq('test message');
  });

  it('Should retry job on fail', () => {
    // TODO: retries & dead letter queue
  });
});
