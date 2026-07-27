import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { JobModel } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

// Broker-free coverage for the queue schema: an in-memory sqlite DB with the
// queue migrations applied, verifying the Phase/Message progress columns.
class JobModelConnectionConf extends FrameworkConfiguration {
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
    };
  }
}

describe('JobModel progress columns', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.clearCache();
    DI.register(JobModelConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
    // runs the queue migrations (incl. the Phase/Message column migration)
    await DI.resolve(Orm);
  });

  it('persists and reads back Phase and Message', async () => {
    const job = new JobModel();
    job.JobId = 'job-1';
    job.Name = 'RenderPdfJob';
    job.Connection = 'queue';
    job.Status = 'executing';
    job.Progress = 42;
    job.Phase = 'loading';
    job.Message = 'Loading resources (12 done)';
    await job.insert();

    const row = await JobModel.where({ JobId: 'job-1' }).firstOrFail();
    expect(row.Progress).to.eq(42);
    expect(row.Phase).to.eq('loading');
    expect(row.Message).to.eq('Loading resources (12 done)');
  });

  it('leaves Phase/Message null when not set', async () => {
    const job = new JobModel();
    job.JobId = 'job-2';
    job.Name = 'LazyUploadJob';
    job.Connection = 'queue';
    job.Status = 'created';
    job.Progress = 0;
    await job.insert();

    const row = await JobModel.where({ JobId: 'job-2' }).firstOrFail();
    expect(row.Phase ?? null).to.eq(null);
    expect(row.Message ?? null).to.eq(null);
  });

  // The consumer now sets Status = 'created' explicitly on first insert rather than relying on
  // the DB column default ( which MySQL's MODIFY COLUMN can drop, and which sqlite stores as a
  // quoted literal ). This guards that an explicitly-assigned 'created' round-trips cleanly,
  // so job tracking never depends on dialect-specific default handling.
  it("persists an explicitly-set 'created' Status cleanly on first insert", async () => {
    const job = new JobModel();
    job.JobId = 'job-3';
    job.Name = 'CreatedStatusJob';
    job.Connection = 'queue';
    job.Status = 'created';
    job.Progress = 0;
    await job.insert();

    const row = await JobModel.where({ JobId: 'job-3' }).firstOrFail();
    expect(row.Status).to.eq('created');
  });
});
