import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Job, JobModel, QueueJob } from '@spinajs/queue';
import { removeTempDir, requireBroker, sleep, uniqueQueue, waitFor } from './support/env.js';
import { startApp, stopApp, tempDbFile } from './support/app.js';

chai.use(chaiAsPromised);
const { expect } = chai;

@Job()
class ItEchoJob extends QueueJob {
  public static Executions: string[] = [];
  public Value: string;

  public async execute() {
    ItEchoJob.Executions.push(this.JobId);
    return { echoed: this.Value };
  }
}

async function statusOf(jobId: string): Promise<string | undefined> {
  return (await JobModel.where({ JobId: jobId }).first())?.Status;
}

describe('ActiveMQ integration - job delivery', function () {
  this.timeout(60000);

  let db: { dir: string; file: string };
  let channel: string;

  before(async function () {
    await requireBroker(this);
  });

  beforeEach(() => {
    db = tempDbFile();
    channel = uniqueQueue('delivery');
    ItEchoJob.Executions = [];
  });

  afterEach(async () => {
    await stopApp();
    removeTempDir(db.dir);
  });

  it('emits a job and records its result in queue_jobs', async () => {
    const queue = await startApp({ dbFile: db.file, jobChannel: channel });
    await queue.consume(ItEchoJob);

    const jobId = (await ItEchoJob.emit({ Value: 'hello' }))!;
    await waitFor(async () => (await statusOf(jobId)) === 'success', 10000, 'job success');

    const row = await JobModel.where({ JobId: jobId }).first();
    expect(row.Result).to.deep.eq({ echoed: 'hello' });
    expect(row.Attempt).to.eq(0);
    expect(ItEchoJob.Executions).to.deep.eq([jobId]);
  });

  it('keeps a persistent job queued while no consumer runs, and delivers it after a restart', async () => {
    await startApp({ dbFile: db.file, jobChannel: channel });
    const jobId = (await ItEchoJob.emit({ Value: 'later' }))!;
    await sleep(1000);
    expect(ItEchoJob.Executions).to.be.empty;
    await stopApp();

    const restarted = await startApp({ dbFile: db.file, jobChannel: channel });
    await restarted.consume(ItEchoJob);

    await waitFor(() => ItEchoJob.Executions.includes(jobId), 10000, 'job delivered after consumer restart');
  });

  it('delivers a job no earlier than its ScheduleDelay', async () => {
    const queue = await startApp({ dbFile: db.file, jobChannel: channel });
    const deliveredAt: number[] = [];
    await queue.consume(ItEchoJob, async () => {
      deliveredAt.push(Date.now());
    });

    const sentAt = Date.now();
    await ItEchoJob.emit({ Value: 'delayed' }, { ScheduleDelay: 3000 } as any);

    await waitFor(() => deliveredAt.length === 1, 15000, 'delayed delivery');
    expect(deliveredAt[0] - sentAt, 'scheduler must hold the job').to.be.at.least(2900);
    expect(deliveredAt[0] - sentAt).to.be.below(8000);
  });

  it('skips a re-emitted job whose JobId already finished, and runs one with a fresh JobId', async () => {
    const queue = await startApp({ dbFile: db.file, jobChannel: channel });
    await queue.consume(ItEchoJob);

    const jobId = (await ItEchoJob.emit({ Value: 'once' }))!;
    await waitFor(() => ItEchoJob.Executions.length === 1, 10000, 'first run');

    await ItEchoJob.emit({ Value: 'again', JobId: jobId } as any);
    const fresh = (await ItEchoJob.emit({ Value: 'fresh' }))!;
    await waitFor(() => ItEchoJob.Executions.includes(fresh), 10000, 'fresh run');
    await sleep(500);

    expect(ItEchoJob.Executions).to.deep.eq([jobId, fresh]);
  });
});
