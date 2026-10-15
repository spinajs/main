import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { randomUUID } from 'crypto';
import { DateTime } from 'luxon';
import { IQueueMessage, JobModel, QueueMessageType, QueueService } from '@spinajs/queue';
import { removeTempDir, requireBroker, sleep, uniqueQueue, waitFor } from './support/env.js';
import { startApp, stopApp, tempDbFile } from './support/app.js';
import { Replica, replicaEnv } from './support/replica.js';

chai.use(chaiAsPromised);
const { expect } = chai;

describe('ActiveMQ integration - replicas', function () {
  this.timeout(120000);

  let db: { dir: string; file: string };
  let channel: string;
  let producer: QueueService;
  const replicas: Replica[] = [];

  before(async function () {
    await requireBroker(this);
  });

  beforeEach(async () => {
    db = tempDbFile();
    channel = uniqueQueue('replicas');
    // migrates the shared DB before any replica opens it, so replicas never race on migrations
    producer = await startApp({ dbFile: db.file, jobChannel: channel });
  });

  afterEach(async () => {
    for (const r of replicas.splice(0)) {
      await r.stop();
    }
    await stopApp();
    removeTempDir(db.dir);
  });

  async function replica(name: string, instanceId?: string): Promise<Replica> {
    const r = await Replica.start(name, replicaEnv({ channel, dbFile: db.file, instanceId }));
    replicas.push(r);
    return r;
  }

  async function emitReplicaJob(extra: Record<string, unknown> = {}): Promise<string> {
    const jobId = randomUUID();
    const message = { Name: 'ReplicaJob', Type: QueueMessageType.Job, JobId: jobId, Persistent: true, Priority: 0, CreatedAt: DateTime.now(), ...extra };
    await producer.get('jobs').emit(message as unknown as IQueueMessage);
    return jobId;
  }

  async function statusOf(jobId: string): Promise<string | undefined> {
    return (await JobModel.where({ JobId: jobId }).first())?.Status;
  }

  it('runs every job exactly once across two replicas', async () => {
    const r1 = await replica('r1', 'r1');
    const r2 = await replica('r2', 'r2');

    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(await emitReplicaJob({ DurationMs: 100 }));
    }

    await waitFor(() => r1.jobs('succeeded').length + r2.jobs('succeeded').length >= 20, 60000, '20 jobs succeeded');
    await sleep(1000);

    const all = [...r1.jobs('succeeded'), ...r2.jobs('succeeded')];
    expect(all).to.have.length(20);
    expect(new Set(all)).to.deep.eq(new Set(ids));
    expect(r1.jobs('succeeded'), 'r1 took a share').to.not.be.empty;
    expect(r2.jobs('succeeded'), 'r2 took a share').to.not.be.empty;
    for (const id of ids) {
      expect(await statusOf(id)).to.eq('success');
    }
  });

  it('refuses a second replica with an identical client-id and says how to fix it', async () => {
    await replica('r1');

    await expect(Replica.start('r2', replicaEnv({ channel, dbFile: db.file }))).to.be.rejectedWith(/QUEUE_INSTANCE_ID/);
  });

  it('redelivers a job to another replica when the first dies before acking it', async () => {
    const r1 = await replica('r1', 'r1');
    const jobId = await emitReplicaJob({ HangOn: 'r1' });
    await waitFor(() => r1.jobs('started').includes(jobId), 10000, 'r1 picked the job');

    const r2 = await replica('r2', 'r2');
    await r1.kill();

    await waitFor(() => r2.jobs('succeeded').includes(jobId), 30000, 'r2 ran the redelivered job');
    expect(await statusOf(jobId)).to.eq('success');
  });

  it('does not re-run a job that succeeded but was not acked before the crash', async () => {
    const r1 = await replica('r1', 'r1');
    const jobId = await emitReplicaJob({ CrashAfterSuccessOn: 'r1' });

    await waitFor(() => r1.exited, 15000, 'r1 crashed after success');
    expect(r1.jobs('succeeded')).to.include(jobId);
    expect(await statusOf(jobId)).to.eq('success');

    const r2 = await replica('r2', 'r2');
    // the redelivered message sits ahead of the probe, so the probe running proves it was acked, not stuck
    const probe = await emitReplicaJob();
    await waitFor(() => r2.jobs('succeeded').includes(probe), 30000, 'r2 drained the queue up to the probe');

    expect(r2.jobs('started'), 'the finished job must not run again').to.not.include(jobId);
  });
});
