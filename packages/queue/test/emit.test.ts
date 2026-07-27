import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Constructor, DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { JobModel, QueueJob, QueueService, Job, QueueClient, IQueueMessage, QueueMessage } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/**
 * Broker-free coverage of DefaultQueueService.emit. A capturing QueueClient fake stashes the
 * emitted wire message (instead of shipping it to a broker) so we can assert the returned JobId
 * matches the message the producer actually emitted. Emit is DB-free by design: it generates and
 * returns the JobId, but the consumer - not the producer - writes the queue_jobs row.
 */
@PerInstanceCheck()
@Injectable(QueueClient)
class CapturingQueueClient extends QueueClient {
  public Emitted: IQueueMessage[] = [];

  public async emit(event: IQueueMessage): Promise<void> {
    this.Emitted.push(event);
  }

  public async subscribe(_channel: string | Constructor<QueueMessage>, _cb: (e: IQueueMessage) => Promise<void>): Promise<void> {
    /* not needed for emit tests */
  }

  public unsubscribe(): void {
    /* noop */
  }
}

class EmitConnectionConf extends FrameworkConfiguration {
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
        default: 'test-queue',
        routing: {},
        connections: [
          {
            service: 'CapturingQueueClient',
            name: 'test-queue',
            defaultQueueChannel: '/queue/test',
            defaultTopicChannel: '/topic/test',
          },
        ],
      },
    };
  }
}

@Job()
class CorrelationJob extends QueueJob {
  public Foo: string;

  public async execute(): Promise<unknown> {
    return 'ok';
  }
}

async function client() {
  const queue = await DI.resolve(QueueService);
  return queue.get('test-queue') as unknown as CapturingQueueClient;
}

describe('DefaultQueueService.emit (job correlation)', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.clearCache();
    DI.register(EmitConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
    await DI.resolve(QueueService);
  });

  it('returns the generated JobId matching the emitted wire message, and writes no DB row', async () => {
    const jobId = await CorrelationJob.emit({ Foo: 'bar' });

    expect(jobId, 'emit returns a JobId').to.be.a('string');

    // the returned id is the one the producer actually put on the wire
    const c = await client();
    expect(c.Emitted.length).to.equal(1);
    expect((c.Emitted[0] as any).JobId).to.equal(jobId);

    // producer is DB-free: the consumer writes the queue_jobs row, not emit()
    const rows = await JobModel.where({ JobId: jobId }).all();
    expect(rows.length, 'emit must not create a queue_jobs row').to.equal(0);
    expect((await JobModel.all()).length).to.equal(0);
  });

  it('returns a distinct JobId per emit', async () => {
    const a = await CorrelationJob.emit({ Foo: '1' });
    const b = await CorrelationJob.emit({ Foo: '2' });

    expect(a).to.not.eq(b);
  });
});
