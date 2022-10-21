import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { StompQueueClient } from './../src';
import * as _ from 'lodash';
import { join, normalize, resolve } from 'path';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { QueueMessageType } from '@spinajs/queue';
import { DateTime } from 'luxon';

chai.use(chaiAsPromised);

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

export function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

export class ConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: {
          targets: [
            {
              name: 'Empty',
              type: 'BlackHoleTarget',
              layout: '{datetime} {level} {message} {error} duration: {duration} ms ({logger})',
            },
          ],

          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
      },
      mergeArrays,
    );
  }
}

async function q() {
  return await DI.resolve(StompQueueClient, [
    {
      host: 'ws://localhost:61614/ws',
      name: 'test-id',
      debug: true,
      defaultQueueChannel: 'queue\\test',
      defaultTopicChannel: 'topic\\test',
    },
  ]);
}

// class TestJob extends QueueJob {
//   public execute(progress: (p: number) => Promise<void>): Promise<unknown> {
//     if (progress) {
//       progress(100);
//     }
//     return Promise.resolve();
//   }
// }

// class TestEvent extends QueueEvent {}

describe('stomp queue transport test', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);

    await DI.resolve(Configuration);
  });

  afterEach(async () => {
    const q = DI.get(StompQueueClient);
    if (q) {
      await q.dispose();
    }
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

    c.emit(message);
  });

  it('Should emit event', async () => {
    const c = await q();

    const message = {
      CreatedAt: DateTime.now(),
      Name: 'TestEvent',
      Type: QueueMessageType.Event,
      Foo: 'far',
    };

    c.subscribe('')

    c.emit(message);
  });
  it('Should emit durable event', async () => {});
  it('Should register on job', async () => {});
  it('Should register on event', async () => {});
  it('Should register on job multiple subscribers', async () => {});
  it('Should register on event multiple subscribers', async () => {});
  it('Should unsubscribe', async () => {});

  it('Should route job with routing table', async () => {});
  it('Should route event with routing table', async () => {});
});
