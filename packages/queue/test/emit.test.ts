import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { JobModel, QueueJob, QueueService, Job } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

// Broker-free coverage of DefaultQueueService.emit: a BlackHole transport (which
// discards messages) plus an in-memory sqlite job store. This exercises the job
// row creation and the returned JobId used for progress correlation.
class ConnectionConf extends FrameworkConfiguration {
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
            service: 'BlackHoleQueueClient',
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

describe('DefaultQueueService.emit (job correlation)', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
    await DI.resolve(QueueService);
  });

  it('returns the generated JobId and creates a matching job row', async () => {
    const jobId = await CorrelationJob.emit({ Foo: 'bar' });

    expect(jobId, 'emit returns a JobId').to.be.a('string');

    const row = await JobModel.where({ JobId: jobId }).firstOrFail();
    expect(row.Name).to.eq('CorrelationJob');
    expect(row.Status).to.eq('created');
    expect(row.Progress).to.eq(0);
  });

  it('returns a distinct JobId per emit', async () => {
    const a = await CorrelationJob.emit({ Foo: '1' });
    const b = await CorrelationJob.emit({ Foo: '2' });

    expect(a).to.not.eq(b);
  });
});
