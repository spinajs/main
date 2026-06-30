import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { join, normalize, resolve } from 'path';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { expect } from 'chai';
import { v4 as uuidv4 } from 'uuid';
import { QueueJob, Job, QueueService, JobModel, DeadLetterModel } from './../src/index.js';
import '@spinajs/orm-sqlite';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';

chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

export class ConnectionConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'queue',
            Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } },
          },
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'sqlite',
            Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } },
          },
        ],
      },
      queue: {
        default: 'black-hole',
        routing: {
          // object route without `connection` -> should fall back to the default connection
          RoutedNoConnection: { channel: '/queue/x' },
        },
        connections: [
          {
            service: 'BlackHoleQueueClient',
            name: 'black-hole',
            defaultQueueChannel: '/queue/test',
            defaultTopicChannel: '/topic/test',
            retry: { maxRetries: 3, delay: 1, backoff: 'Constant' },
          },
        ],
      },
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    };
  }
}

@Job()
class SuccessJob extends QueueJob {
  public async execute() {
    return 'done';
  }
}

@Job()
class FlakyJob extends QueueJob {
  public attempts = 0;
  public failUntil = 2;

  public async execute() {
    this.attempts++;
    if (this.attempts <= this.failUntil) {
      throw new Error(`fail #${this.attempts}`);
    }
    return 'recovered';
  }
}

@Job()
class AlwaysFailJob extends QueueJob {
  public attempts = 0;

  public async execute() {
    this.attempts++;
    throw new Error('permanent failure');
  }
}

async function q() {
  return DI.resolve(QueueService);
}

/**
 * Seeds a `queue_jobs` row for a job ( mimicking what `emit` does before dispatch )
 * so `executeJob` can find and update it.
 */
async function seed(job: QueueJob, connection = 'black-hole') {
  job.JobId = uuidv4();
  const m = new JobModel();
  m.JobId = job.JobId;
  m.Name = job.Name;
  m.Status = 'created';
  m.Progress = 0;
  m.Connection = connection;
  await m.insert();
}

describe('queue retry / dead letter', function () {
  this.timeout(20000);

  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    const queue = await q();
    await queue.dispose();
  });

  it('runs the migration creating the dead letter table', async () => {
    await q();
    // should not throw - table exists
    const rows = await DeadLetterModel.all();
    expect(rows).to.be.an('array').with.lengthOf(0);
  });

  it('routing falls back to default connection for an object route without connection', async () => {
    const queue = await q();
    const connections = (queue as any).getConnectionsForMessage({ Name: 'RoutedNoConnection' });
    expect(connections).to.deep.equal(['black-hole']);
  });

  it('executes a job and stores the result', async () => {
    const queue = await q();
    const job = new SuccessJob();
    await seed(job);

    await (queue as any).executeJob(job, SuccessJob, 'black-hole');

    const model = await JobModel.where({ JobId: job.JobId }).first();
    expect(model.Status).to.eq('success');
    expect(model.Result).to.eq('done');
    expect(model.Progress).to.eq(100);
  });

  it('retries a flaky job and succeeds, tracking attempts', async () => {
    const queue = await q();
    const job = new FlakyJob();
    job.failUntil = 2; // fail twice, succeed on 3rd execution
    await seed(job);

    await (queue as any).executeJob(job, FlakyJob, 'black-hole');

    expect(job.attempts).to.eq(3);
    const model = await JobModel.where({ JobId: job.JobId }).first();
    expect(model.Status).to.eq('success');
    expect(model.Result).to.eq('recovered');
    expect(model.RetryCount).to.eq(2);

    // no dead letter entries on success
    expect(await DeadLetterModel.all()).to.have.lengthOf(0);
  });

  it('dead-letters a job that exhausts its retries', async () => {
    const queue = await q();
    const job = new AlwaysFailJob();
    job.RetryCount = 1; // per-job override: 1 retry then give up
    await seed(job);

    await (queue as any).executeJob(job, AlwaysFailJob, 'black-hole');

    expect(job.attempts).to.eq(2); // original + 1 retry
    const model = await JobModel.where({ JobId: job.JobId }).first();
    expect(model.Status).to.eq('dead-letter');
    expect(model.LastError).to.contain('permanent failure');
    expect(model.DeadLetteredAt).to.be.not.null;

    const dead = await DeadLetterModel.all();
    expect(dead).to.have.lengthOf(1);
    expect(dead[0].Name).to.eq('AlwaysFailJob');
    expect(dead[0].JobId).to.eq(job.JobId);
    expect(dead[0].Error).to.contain('permanent failure');
    expect(dead[0].RetryCount).to.eq(1);
  });

  it('requeues a dead lettered job and removes the entry', async () => {
    const queue = await q();
    const job = new AlwaysFailJob();
    job.RetryCount = 0;
    await seed(job);

    await (queue as any).executeJob(job, AlwaysFailJob, 'black-hole');

    const dead = await DeadLetterModel.all();
    expect(dead).to.have.lengthOf(1);
    const entryId = dead[0].Id;

    const jobsBefore = await JobModel.all();
    await queue.requeueDeadLetter(entryId);

    // entry removed
    expect(await DeadLetterModel.all()).to.have.lengthOf(0);
    // a fresh job row was created by emit
    const jobsAfter = await JobModel.all();
    expect(jobsAfter.length).to.eq(jobsBefore.length + 1);
  });

  it('throws when requeueing a missing dead letter entry', async () => {
    const queue = await q();
    await expect(queue.requeueDeadLetter(99999)).to.be.rejected;
  });
});
