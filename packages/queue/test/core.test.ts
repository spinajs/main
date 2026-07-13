import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI, Injectable, NewInstance, Constructor } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { v4 as uuidv4 } from 'uuid';
import { DateTime } from 'luxon';
import { QueueJob, QueueEvent, Job, Event, QueueService, JobModel, JobRetentionService, QueueClient, IQueueMessage, QueueMessage } from './../src/index.js';
import '@spinajs/orm-sqlite';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';

chai.use(chaiAsPromised);

/**
 * In-memory transport that immediately delivers an emitted message to the matching subscriber,
 * so the core consume() path ( dedup, execute, persist ) can be tested without a broker.
 */
@NewInstance()
@Injectable(QueueClient)
class InMemoryQueueClient extends QueueClient {
  public static Subs = new Map<string, (e: IQueueMessage) => Promise<void>>();
  public static Last?: IQueueMessage;

  public async emit(e: IQueueMessage): Promise<void> {
    InMemoryQueueClient.Last = e;
    const cb = InMemoryQueueClient.Subs.get(e.Name);
    if (cb) {
      await cb(e);
    }
  }
  public async subscribe(channelOrMessage: string | Constructor<QueueMessage>, callback: (e: IQueueMessage) => Promise<void>): Promise<void> {
    const key = typeof channelOrMessage === 'string' ? channelOrMessage : channelOrMessage.name;
    InMemoryQueueClient.Subs.set(key, callback);
  }
  public unsubscribe(): void {
    /* noop */
  }
}

class ConnectionConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'queue', Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } } },
          { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite', Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } } },
        ],
      },
      queue: {
        default: 'memory',
        connections: [{ service: 'InMemoryQueueClient', name: 'memory', defaultQueueChannel: '/queue/test', defaultTopicChannel: '/topic/test' }],
        retention: { service: 'DefaultJobRetentionService', enabled: false },
      },
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
    };
  }
}

@Job()
class SampleJob extends QueueJob {
  public Foo: string;
  public async execute() {
    return 'ok';
  }
}

@Event()
class SampleEvent extends QueueEvent {
  public Bar: string;
}

@Job()
class FailingJob extends QueueJob {
  public async execute() {
    throw new Error('kaboom');
  }
}

@Job()
class ProgressJob extends QueueJob {
  public async execute(progress: (p: number) => Promise<void>) {
    for (let p = 1; p <= 100; p++) {
      await progress(p);
    }
    return 'done';
  }
}

async function q() {
  return DI.resolve(QueueService);
}

/** Inserts a queue_jobs row directly, for retention/purge tests. */
async function seedJob(status: string): Promise<JobModel> {
  const m = new JobModel();
  m.JobId = uuidv4();
  m.Name = 'Seed';
  m.Status = status as any;
  m.Progress = 0;
  m.Attempt = 0;
  m.MaxAttempts = 0;
  m.Connection = 'memory';
  await m.insert();
  return m;
}

describe('queue core - dedup & persistence', function () {
  this.timeout(20000);

  beforeEach(async () => {
    DI.clearCache();
    InMemoryQueueClient.Subs.clear();
    InMemoryQueueClient.Last = undefined;
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    sinon.restore();
    const queue = await q();
    await queue.dispose();
  });

  it('emits jobs as persistent by default and events as non-persistent', async () => {
    await q();

    await SampleJob.emit({ Foo: 'x' });
    expect(InMemoryQueueClient.Last!.Persistent, 'job should default to persistent').to.eq(true);

    await SampleEvent.emit({ Bar: 'y' });
    expect(InMemoryQueueClient.Last!.Persistent, 'event should not be persistent').to.not.eq(true);
  });

  it('lets the caller override persistence for a job', async () => {
    await q();
    await SampleJob.emit({ Foo: 'x' }, { Persistent: false } as any);
    expect(InMemoryQueueClient.Last!.Persistent).to.eq(false);
  });

  it('executes a job once, then skips duplicate deliveries ( dedup )', async () => {
    const queue = await q();
    const spy = sinon.spy(SampleJob.prototype, 'execute');

    await queue.consume(SampleJob);
    await SampleJob.emit({ Foo: 'x' }); // creates JobModel + delivers -> executes once

    expect(spy.calledOnce).to.be.true;

    const delivered = InMemoryQueueClient.Last!;
    const model = await JobModel.where({ JobId: (delivered as any).JobId }).first();
    expect(model.Status).to.eq('success');

    // redeliver the exact same message ( at-least-once duplicate )
    const cb = InMemoryQueueClient.Subs.get('SampleJob')!;
    await cb(delivered);
    await cb(delivered);

    expect(spy.calledOnce, 'duplicate deliveries must not re-execute the job').to.be.true;
  });

  it('stores MaxAttempts ( job RetryCount ) at dispatch', async () => {
    await q();
    await SampleJob.emit({ Foo: 'x', RetryCount: 4 } as any);

    const model = await JobModel.where({ JobId: (InMemoryQueueClient.Last as any).JobId }).first();
    expect(model.MaxAttempts).to.eq(4);
  });

  it('records failures in LastError ( not Result ) and marks the job dead', async () => {
    const queue = await q();
    await queue.consume(FailingJob);

    // consume rethrows on failure, so emit rejects; the JobModel is updated before the throw
    await expect(FailingJob.emit({} as any)).to.be.rejectedWith('kaboom');

    const model = await JobModel.where({ JobId: (InMemoryQueueClient.Last as any).JobId }).first();
    expect(model.Status).to.eq('dead'); // RetryCount 0 -> attempt 1 > 0 -> dead
    expect(model.LastError).to.contain('kaboom');
    expect(model.Result, 'result must not hold the error').to.be.null;
  });

  it('throttles progress DB writes', async () => {
    const queue = await q();
    const updateSpy = sinon.spy(JobModel.prototype, 'update');

    await queue.consume(ProgressJob);
    await ProgressJob.emit({} as any);

    const model = await JobModel.where({ JobId: (InMemoryQueueClient.Last as any).JobId }).first();
    expect(model.Progress).to.eq(100); // final always persisted
    expect(model.Status).to.eq('success');
    // 100 progress callbacks must not translate into 100 writes
    expect(updateSpy.callCount, 'progress writes should be throttled').to.be.lessThan(40);
  });

  it('purges terminal jobs older than a cutoff via query scopes', async () => {
    const retention = await DI.resolve(JobRetentionService);

    await seedJob('success');
    await seedJob('dead');
    await seedJob('created'); // active - must survive

    // nothing is older than a past cutoff
    expect(await retention.purgeJobs(DateTime.now().minus({ days: 1 }))).to.eq(0);

    // future cutoff -> all rows are "older"; only terminal ones are purged
    const removed = await retention.purgeJobs(DateTime.now().plus({ days: 1 }));
    expect(removed).to.eq(2);

    const remaining = await JobModel.all();
    expect(remaining).to.have.lengthOf(1);
    expect(remaining[0].Status).to.eq('created');
  });
});
