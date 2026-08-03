import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Constructor, DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { QueueService, QueueClient, QueueJob, IQueueMessage, QueueMessage, Job } from '../src/index.js';
import { _ev } from '../src/fp.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/**
 * Capturing client - stashes emitted wire messages instead of shipping to a broker,
 * so `_ev` behavior can be asserted without infrastructure.
 */
@PerInstanceCheck()
@Injectable(QueueClient)
class FpCapturingQueueClient extends QueueClient {
  public Emitted: IQueueMessage[] = [];

  public async emit(event: IQueueMessage): Promise<void> {
    this.Emitted.push(event);
  }

  public async subscribe(_channel: string | Constructor<QueueMessage>, _cb: (e: IQueueMessage) => Promise<void>): Promise<void> {
    /* not needed */
  }

  public unsubscribe(): void {
    /* noop */
  }
}

class FpConnectionConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      db: {
        DefaultConnection: 'queue',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'queue',
            Migration: {
              OnStartup: true,
              Table: 'orm_migrations',
              Transaction: { Mode: MigrationTransactionMode.PerMigration },
            },
          },
        ],
      },
      queue: {
        default: 'fp-test-queue',
        routing: {},
        connections: [
          {
            service: 'FpCapturingQueueClient',
            name: 'fp-test-queue',
            defaultQueueChannel: '/queue/fp-test',
            defaultTopicChannel: '/topic/fp-test',
          },
        ],
      },
    };
  }
}

@Job()
class FpTestJob extends QueueJob {
  public Foo: string;

  public async execute(): Promise<unknown> {
    return 'ok';
  }
}

async function client() {
  const queue = await DI.resolve(QueueService);
  return queue.get('fp-test-queue') as unknown as FpCapturingQueueClient;
}

describe('queue fp', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.clearCache();
    DI.register(FpConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
    await DI.resolve(QueueService);
  });

  it('_ev emits the message through the queue service', async () => {
    const job = new FpTestJob();
    job.Foo = 'bar';

    await _ev(job)();

    const c = await client();
    expect(c.Emitted.length).to.eq(1);
    expect((c.Emitted[0] as any).Foo).to.eq('bar');
  });

  it('_ev is lazy - nothing is emitted until the thunk is called', async () => {
    const job = new FpTestJob();
    job.Foo = 'lazy';

    const thunk = _ev(job);

    const c = await client();
    expect(c.Emitted.length).to.eq(0);

    await thunk();
    expect(c.Emitted.length).to.eq(1);
  });
});
