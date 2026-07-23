import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Constructor, DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { expect } from 'chai';
import { QueueJob, Job, QueueService, JobModel, QueueClient, IQueueMessage, QueueMessage } from './../src/index.js';
import '@spinajs/orm-sqlite';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';

chai.use(chaiAsPromised);

/**
 * Broker-free QueueClient stub. `emit` stashes the wire message; `deliver` replays a
 * message to every registered `subscribe` callback so we can drive `consume` deterministically
 * (including a redelivery of the SAME wire message with the SAME JobId).
 */
@PerInstanceCheck()
@Injectable(QueueClient)
class TestQueueClient extends QueueClient {
  public Emitted: IQueueMessage[] = [];
  private Callbacks: Array<(e: IQueueMessage) => Promise<void>> = [];

  public async emit(event: IQueueMessage): Promise<void> {
    this.Emitted.push(event);
  }

  public async subscribe(_channel: string | Constructor<QueueMessage>, callback: (e: IQueueMessage) => Promise<void>): Promise<void> {
    this.Callbacks.push(callback);
  }

  public unsubscribe(): void {
    this.Callbacks = [];
  }

  /** test helper: replay a wire message to all subscribers (simulates a broker delivery) */
  public async deliver(event: IQueueMessage): Promise<void> {
    for (const cb of this.Callbacks) {
      await cb(event);
    }
  }
}

class ConnectionConf extends FrameworkConfiguration {
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
        default: 'test-queue',
        routing: {},
        connections: [
          {
            service: 'TestQueueClient',
            name: 'test-queue',
            defaultQueueChannel: '/queue/test',
            defaultTopicChannel: '/topic/test',
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
class TrackedJob extends QueueJob {
  public ShouldFail = false;
  public RetryCount = 2;

  public async execute() {
    if (this.ShouldFail) {
      throw new Error('boom');
    }
    return 'ok';
  }
}

async function q() {
  return DI.resolve(QueueService);
}

async function client() {
  const queue = await DI.resolve(QueueService);
  return queue.get('test-queue') as unknown as TestQueueClient;
}

describe('queue tracking (producer generates JobId, consumer find-or-create)', function () {
  this.timeout(15000);

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

  it('emit does not write a queue_jobs row (producer is DB-free)', async () => {
    const before = (await JobModel.all()).length;

    await TrackedJob.emit({});

    const after = (await JobModel.all()).length;
    expect(after).to.equal(before);
    expect(after).to.equal(0);

    // message was actually produced to the transport
    const c = await client();
    expect(c.Emitted.length).to.equal(1);
    expect((c.Emitted[0] as any).JobId).to.be.a('string');
  });

  it('consume creates the row on first receipt and runs execute()', async () => {
    const queue = await q();
    await queue.consume(TrackedJob);
    await TrackedJob.emit({});

    const c = await client();
    const wire = c.Emitted[0];
    await c.deliver(wire);

    const rows = await JobModel.all();
    expect(rows.length).to.equal(1);

    const row = rows[0] as JobModel<unknown>;
    expect(row.JobId).to.equal((wire as any).JobId);
    expect(row.Name).to.equal('TrackedJob');
    expect(row.Status).to.equal('success');
    expect(row.Result).to.equal('ok');
    expect(row.Progress).to.equal(100);
  });

  it('a redelivery updates the existing row and bumps Attempt on failure (one row, not two)', async () => {
    const queue = await q();
    await queue.consume(TrackedJob);
    await TrackedJob.emit({ ShouldFail: true });

    const c = await client();
    const wire = c.Emitted[0];

    // first receipt: inserts row, execute throws -> Attempt 1
    await expect(c.deliver(wire)).to.be.rejectedWith('boom');
    // redelivery of the SAME wire message (same JobId): updates the row, execute throws -> Attempt 2
    await expect(c.deliver(wire)).to.be.rejectedWith('boom');

    const rows = await JobModel.all();
    expect(rows.length).to.equal(1); // NOT two rows

    const row = rows[0] as JobModel<unknown>;
    expect(row.JobId).to.equal((wire as any).JobId);
    expect(row.Attempt).to.equal(2);
    expect(['retrying', 'dead']).to.include(row.Status);
  });
});
