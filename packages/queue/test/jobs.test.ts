import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import * as _ from 'lodash';
import { join, normalize, resolve } from 'path';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Queues } from './../src';
import { DateTime } from 'luxon';
import { expect } from 'chai';

import '@spinajs/queue-stomp-transport';

chai.use(chaiAsPromised);

const TestEventChannelName = `/topic/test-${DateTime.now().toMillis()}`;
const TestJobChannelName = `/queue/test-${DateTime.now().toMillis()}`;
// const QUEUE_WAIT_TIME_MS = 1000;

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

export function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

// async function wait(amount?: number) {
//   return new Promise<void>((res) => {
//     setTimeout(() => {
//       res();
//     }, amount ?? QUEUE_WAIT_TIME_MS);
//   });
// }

export class ConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
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

async function q() {
  return DI.resolve(Queues);
}

describe('jobs', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);

    await DI.resolve(Configuration);
  });

  it('should connecto to queue server', async () => {
    const queue = await q();

    const c = await queue.get();
    expect(c).to.be.not.null;
  });
  it('should subscribe to jobs');
  it('should subscribe to events');

  it('Should preserve job result', () => {});

  it('Should retry job on fail', () => {});
});
