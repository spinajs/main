import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as sinon from 'sinon';
import { IJobFailureContext, IQueueMessage, Job, JobModel, QueueJob } from '@spinajs/queue';
import { removeTempDir, requireBroker, uniqueQueue, waitFor } from './support/env.js';
import { client, disposeClients, useConfig } from './support/client.js';
import { jobIdOf, jobMessage } from './support/messages.js';
import { startApp, stopApp, tempDbFile } from './support/app.js';

chai.use(chaiAsPromised);
const { expect } = chai;

@Job()
class ItFailingJob extends QueueJob {
  public static Failures: IJobFailureContext[] = [];
  public async execute(): Promise<unknown> {
    throw new Error('always fails');
  }
  public async onFailed(_err: unknown, ctx: IJobFailureContext) {
    ItFailingJob.Failures.push(ctx);
  }
}

@Job()
class ItRoutedFailingJob extends QueueJob {
  public static Runs = 0;
  public async execute(): Promise<unknown> {
    ItRoutedFailingJob.Runs++;
    throw new Error('routed failure');
  }
}

describe('ActiveMQ integration - retries and dead letters', function () {
  this.timeout(60000);

  let db: { dir: string; file: string } | undefined;

  before(async function () {
    await requireBroker(this);
  });

  beforeEach(async () => {
    ItFailingJob.Failures = [];
    ItRoutedFailingJob.Runs = 0;
    await useConfig();
  });

  afterEach(async () => {
    await disposeClients();
    await stopApp();
    if (db) {
      removeTempDir(db.dir);
      db = undefined;
    }
  });

  it('backs off exponentially between retries using AMQ_SCHEDULED_DELAY', async () => {
    const src = uniqueQueue('backoff-src');
    const dlq = uniqueQueue('backoff-dlq');
    const c = await client({ defaultQueueChannel: src, defaultQueueDeadLetterChannel: dlq, retryDelay: 1000 });
    const attempts: number[] = [];
    const dead = sinon.stub().resolves();

    await c.subscribe(src, async () => {
      attempts.push(Date.now());
      throw new Error('boom');
    });
    await c.subscribe(dlq, dead);

    const sent = jobMessage({ RetryCount: 2 });
    await c.emit(sent);

    await waitFor(() => dead.calledOnce, 20000, 'dead-lettered after retries');
    expect(attempts).to.have.length(3);
    expect(attempts[1] - attempts[0], 'retry 1 waits retryDelay').to.be.within(900, 2500);
    expect(attempts[2] - attempts[1], 'retry 2 waits 2 x retryDelay').to.be.within(1900, 3500);
    expect(jobIdOf(dead.firstCall.args[0] as IQueueMessage)).to.eq(jobIdOf(sent));
  });

  it('retries a failing job RetryCount times, then marks it dead and dead-letters it', async () => {
    db = tempDbFile();
    const src = uniqueQueue('job-src');
    const dlq = uniqueQueue('job-dlq');
    const queue = await startApp({ dbFile: db.file, jobChannel: src, deadLetterChannel: dlq, retryDelay: 200 });
    const dead = sinon.stub().resolves();
    await queue.consume(ItFailingJob);
    await queue.get('jobs').subscribe(dlq, dead);

    const jobId = (await ItFailingJob.emit({ RetryCount: 2 } as any))!;

    await waitFor(() => dead.calledOnce, 20000, 'dead-letter delivery');
    const row = await JobModel.where({ JobId: jobId }).first();
    expect(row.Status).to.eq('dead');
    expect(row.Attempt).to.eq(3);
    expect(row.MaxAttempts).to.eq(3);
    expect(row.LastError).to.contain('always fails');
    expect(ItFailingJob.Failures.map((f) => f.isFinal)).to.deep.eq([false, false, true]);
    expect(jobIdOf(dead.firstCall.args[0] as IQueueMessage)).to.eq(jobId);
  });

  it('applies routing maxRetries and the per-route dead-letter channel', async () => {
    db = tempDbFile();
    const src = uniqueQueue('routed-src');
    const dlq = uniqueQueue('routed-dlq');
    const queue = await startApp({
      dbFile: db.file,
      jobChannel: uniqueQueue('unused'),
      retryDelay: 100,
      routing: { ItRoutedFailingJob: { connection: 'jobs', channel: src, deadLetterChannel: dlq, maxRetries: 1 } },
    });
    const dead = sinon.stub().resolves();
    await queue.consume(ItRoutedFailingJob);
    await queue.get('jobs').subscribe(dlq, dead);

    const jobId = (await ItRoutedFailingJob.emit({}))!;

    await waitFor(() => dead.calledOnce, 20000, 'routed dead-letter delivery');
    expect(ItRoutedFailingJob.Runs).to.eq(2);
    const row = await JobModel.where({ JobId: jobId }).first();
    expect(row.Status).to.eq('dead');
    expect(row.MaxAttempts).to.eq(2);
  });
});
