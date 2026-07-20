import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { QueueJob, Job, QueueService, JobModel } from '@spinajs/queue';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import { DateTime } from 'luxon';
import { expect } from 'chai';
import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import '@spinajs/orm-sqlite';
// side-effect import: registers SqsQueueClient with the DI container so the
// `service: 'SqsQueueClient'` connection below resolves.
import '../src/connection.js';
import { SQS_ENDPOINT, SQS_REGION, SQS_CREDENTIALS } from './common.js';

// raw SDK client used only by the harness to create / delete the localstack queue.
const raw = new SQSClient({
  region: SQS_REGION,
  endpoint: SQS_ENDPOINT,
  credentials: SQS_CREDENTIALS,
});

// per-run queue name so repeated runs against a long-lived localstack never
// read each other's leftovers.
const QUEUE_NAME = `sqs-e2e-test-${DateTime.now().toMillis()}`;

let queueUrl: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn: () => boolean | Promise<boolean>, timeoutMs = 15000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('waitUntil timed out');
    }
    await sleep(intervalMs);
  }
}

/**
 * Full-stack e2e config: a `queue` ORM connection (in-memory sqlite) so
 * JobModel / queue_jobs exist, and a single SQS transport connection pointed at
 * localstack. The routing entry for SqsE2EJob is filled in at runtime once the
 * queue URL is known (see `before`).
 */
class E2EConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
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
              Transaction: {
                Mode: MigrationTransactionMode.PerMigration,
              },
            },
          },
        ],
      },
      queue: {
        default: 'sqs',
        routing: {},
        connections: [
          {
            service: 'SqsQueueClient',
            name: 'sqs',
            options: {
              region: SQS_REGION,
              endpoint: SQS_ENDPOINT,
              credentials: SQS_CREDENTIALS,
              // short long-poll so the loop cycles / tears down fast in tests
              waitTimeSeconds: 1,
              visibilityTimeout: 30,
            },
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
class SqsE2EJob extends QueueJob {
  public Payload: string;

  public async execute() {
    return 'done:' + this.Payload;
  }
}

describe('sqs queue transport e2e ( producer DB-free, consumer writes the row )', function () {
  this.timeout(60000);

  before(async () => {
    DI.clearCache();
    DI.register(E2EConfiguration).as(Configuration);

    const cfg = await DI.resolve(Configuration);

    // create the real queue against localstack and wire its URL into routing so
    // both emit and consume resolve to the same SQS queue.
    const created = await raw.send(new CreateQueueCommand({ QueueName: QUEUE_NAME }));
    queueUrl = created.QueueUrl!;
    cfg.set(['queue', 'routing', 'SqsE2EJob'], queueUrl);

    // migrate queue_jobs into the in-memory sqlite before resolving the service.
    await DI.resolve(Orm);
    await DI.resolve(QueueService);
  });

  after(async () => {
    try {
      const queue = await DI.resolve(QueueService);
      await queue.dispose();
    } catch {
      /* best effort */
    }
    try {
      if (queueUrl) {
        await raw.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      }
    } catch {
      /* best effort cleanup */
    }
    raw.destroy();
  });

  it('emit (DB-free) + SQS round-trip -> consumer creates the queue_jobs row and runs execute()', async () => {
    const queue = await DI.resolve(QueueService);

    // PRODUCER PATH: emit only stamps a JobId and sends to SQS - it must NOT
    // write any queue_jobs row. We emit BEFORE starting the consumer so this
    // assertion is deterministic: the message waits on the SQS queue and no
    // consumer has run yet.
    await SqsE2EJob.emit({ Payload: 'hello' });

    const afterEmit = await JobModel.all();
    expect(afterEmit.length, 'producer wrote a queue_jobs row - it must be DB-free').to.equal(0);

    // CONSUMER PATH: start the SQS long-poll. QueueService.consume wires the
    // find-or-create + execute() dispatch; the row is created consumer-side.
    await queue.consume(SqsE2EJob);

    // wait until the consumer has created the tracking row and marked it success.
    await waitUntil(async () => {
      const rows = await JobModel.where({ Name: 'SqsE2EJob' }).all();
      return rows.length > 0 && (rows[0] as JobModel<unknown>).Status === 'success';
    });

    const rows = await JobModel.all();

    // exactly one row, created consumer-side, with execute()'s result recorded.
    expect(rows.length, 'expected exactly one queue_jobs row (consumer-side)').to.equal(1);

    const row = rows[0] as JobModel<unknown>;
    expect(row.Name).to.equal('SqsE2EJob');
    expect(row.Status).to.equal('success');
    expect(row.Connection).to.equal('sqs');
    expect(row.Progress).to.equal(100);
    // proof execute() actually ran against the delivered payload
    expect(row.Result).to.equal('done:hello');
    expect(row.JobId).to.be.a('string');
  });
});
