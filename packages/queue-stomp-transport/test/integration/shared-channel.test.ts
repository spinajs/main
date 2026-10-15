import { Job, QueueJob } from '@spinajs/queue';
import { removeTempDir, requireBroker, uniqueQueue, waitFor } from './support/env.js';
import { startApp, stopApp, tempDbFile } from './support/app.js';

@Job()
class ItSharedAJob extends QueueJob {
  public static Runs: string[] = [];
  public async execute() {
    ItSharedAJob.Runs.push(this.JobId);
    return 'a';
  }
}

@Job()
class ItSharedBJob extends QueueJob {
  public static Runs: string[] = [];
  public async execute() {
    ItSharedBJob.Runs.push(this.JobId);
    return 'b';
  }
}

describe('ActiveMQ integration - message types sharing a channel', function () {
  this.timeout(60000);

  let db: { dir: string; file: string };

  before(async function () {
    await requireBroker(this);
  });

  beforeEach(() => {
    db = tempDbFile();
  });

  afterEach(async () => {
    await stopApp();
    removeTempDir(db.dir);
  });

  it('runs two job types that share the default queue channel', async () => {
    const queue = await startApp({ dbFile: db.file, jobChannel: uniqueQueue('shared') });
    await queue.consume(ItSharedAJob);
    await queue.consume(ItSharedBJob);

    const a = (await ItSharedAJob.emit({}))!;
    const b = (await ItSharedBJob.emit({}))!;

    await waitFor(() => ItSharedAJob.Runs.includes(a) && ItSharedBJob.Runs.includes(b), 10000, 'both job types executed');
  });
});
