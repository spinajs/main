import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Constructor, DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { QueueJob, Job, QueueService, JobModel, QueueClient, IQueueMessage, QueueMessage, IJobFailureContext } from './../src/index.js';
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

/**
 * Toggles the `queue.deduplicate` config seen by {@link TrackingConnectionConf}. `undefined` omits the key
 * entirely so the service falls back to its documented default ( true ). Set per-suite in beforeEach.
 */
let CONFIG_DEDUP: boolean | undefined = undefined;

class TrackingConnectionConf extends FrameworkConfiguration {
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
        ...(CONFIG_DEDUP !== undefined ? { deduplicate: CONFIG_DEDUP } : {}),
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

/** Records every onFailed invocation so a test can assert attempt / isFinal per delivery. */
const hookCalls: IJobFailureContext[] = [];

@Job()
class HookedJob extends QueueJob {
  public RetryCount = 1;

  public async execute() {
    throw new Error('boom');
  }

  public async onFailed(_err: unknown, ctx: IJobFailureContext) {
    hookCalls.push(ctx);
  }
}

@Job()
class ThrowingHookJob extends QueueJob {
  public RetryCount = 0;

  public async execute() {
    throw new Error('boom');
  }

  public async onFailed() {
    throw new Error('hook exploded');
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
    CONFIG_DEDUP = undefined; // default ( dedup on )
    hookCalls.length = 0;
    DI.register(TrackingConnectionConf).as(Configuration);

    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    sinon.restore();
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

  it('emit() returns the JobId and it matches the wire message; no row is created by emit alone', async () => {
    const jobId = await TrackedJob.emit({});
    expect(jobId, 'emit returns the generated JobId').to.be.a('string');

    const c = await client();
    expect(c.Emitted.length).to.equal(1);
    expect((c.Emitted[0] as any).JobId).to.equal(jobId);

    // producer is DB-free - only the consumer writes the tracking row
    expect((await JobModel.all()).length).to.equal(0);
  });

  it('persists MaxAttempts ( job RetryCount ) on first receipt', async () => {
    const queue = await q();
    await queue.consume(TrackedJob);
    await TrackedJob.emit({ RetryCount: 3 });

    const c = await client();
    const wire = c.Emitted[0];
    await c.deliver(wire);

    const row = await JobModel.where({ JobId: (wire as any).JobId }).firstOrFail();
    expect(row.MaxAttempts).to.equal(3);
  });

  it('transitions retrying -> dead across redeliveries using the dispatch-time limit', async () => {
    const queue = await q();
    await queue.consume(TrackedJob);
    await TrackedJob.emit({ ShouldFail: true, RetryCount: 1 });

    const c = await client();
    const wire = c.Emitted[0];

    // first receipt: attempt 1 of maxAttempts 1 -> still retrying
    await expect(c.deliver(wire)).to.be.rejectedWith('boom');
    let row = await JobModel.where({ JobId: (wire as any).JobId }).firstOrFail();
    expect(row.Status).to.equal('retrying');
    expect(row.Attempt).to.equal(1);
    expect(row.MaxAttempts).to.equal(1);

    // redelivery: attempt 2 exceeds the limit -> dead
    await expect(c.deliver(wire)).to.be.rejectedWith('boom');
    row = await JobModel.where({ JobId: (wire as any).JobId }).firstOrFail();
    expect(row.Status).to.equal('dead');
    expect(row.Attempt).to.equal(2);
  });

  it('dedup ON ( default ): a redelivery of a succeeded job is skipped ( execute runs once )', async () => {
    const queue = await q();
    const spy = sinon.spy(TrackedJob.prototype, 'execute');

    await queue.consume(TrackedJob);
    await TrackedJob.emit({});

    const c = await client();
    const wire = c.Emitted[0];

    await c.deliver(wire); // executes, marks success
    await c.deliver(wire); // duplicate - must be skipped

    expect(spy.callCount, 'execute must run exactly once').to.equal(1);

    const row = await JobModel.where({ JobId: (wire as any).JobId }).firstOrFail();
    expect(row.Status).to.equal('success');
  });

  it('onFailed is called per failure with correct attempt / isFinal', async () => {
    const queue = await q();
    await queue.consume(HookedJob);
    await HookedJob.emit({});

    const c = await client();
    const wire = c.Emitted[0];

    await expect(c.deliver(wire)).to.be.rejectedWith('boom'); // attempt 1, retrying
    await expect(c.deliver(wire)).to.be.rejectedWith('boom'); // attempt 2, dead

    expect(hookCalls.length).to.equal(2);

    expect(hookCalls[0].attempt).to.equal(1);
    expect(hookCalls[0].maxAttempts).to.equal(1);
    expect(hookCalls[0].isFinal).to.equal(false);
    expect(hookCalls[0].jobId).to.equal((wire as any).JobId);

    expect(hookCalls[1].attempt).to.equal(2);
    expect(hookCalls[1].isFinal).to.equal(true);
  });

  it('a throwing onFailed does not change job status and does not prevent the consumer rethrow', async () => {
    const queue = await q();
    await queue.consume(ThrowingHookJob);
    await ThrowingHookJob.emit({});

    const c = await client();
    const wire = c.Emitted[0];

    // RetryCount 0 -> first failure is final ( dead ); the throwing hook must not mask 'boom'
    await expect(c.deliver(wire)).to.be.rejectedWith('boom');

    const row = await JobModel.where({ JobId: (wire as any).JobId }).firstOrFail();
    expect(row.Status).to.equal('dead');
    expect(row.Attempt).to.equal(1);
    expect(row.LastError).to.contain('boom');
  });
});

describe('queue dedup OFF ( queue.deduplicate: false )', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.clearCache();
    CONFIG_DEDUP = false;
    DI.register(TrackingConnectionConf).as(Configuration);

    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    sinon.restore();
    const queue = await q();
    await queue.dispose();
  });

  it('re-executes a succeeded job on redelivery when dedup is disabled', async () => {
    const queue = await q();
    const spy = sinon.spy(TrackedJob.prototype, 'execute');

    await queue.consume(TrackedJob);
    await TrackedJob.emit({});

    const c = await client();
    const wire = c.Emitted[0];

    await c.deliver(wire);
    await c.deliver(wire);

    expect(spy.callCount, 'dedup off -> execute runs on every delivery').to.equal(2);

    const row = await JobModel.where({ JobId: (wire as any).JobId }).firstOrFail();
    expect(row.Status).to.equal('success');
  });
});
