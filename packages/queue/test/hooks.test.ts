import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Constructor, DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { expect } from 'chai';
import { QueueJob, Job, jobOptions, QueueService, JobModel, QueueClient, QueueMessageHook, QueueTrackingHook, IQueueMessage, QueueMessage } from './../src/index.js';
import '@spinajs/orm-sqlite';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';

chai.use(chaiAsPromised);

@PerInstanceCheck()
@Injectable(QueueClient)
class HookTestQueueClient extends QueueClient {
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

  public async deliver(event: IQueueMessage): Promise<void> {
    for (const cb of this.Callbacks) {
      await cb(event);
    }
  }
}

class HookConf extends FrameworkConfiguration {
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
              Transaction: { Mode: MigrationTransactionMode.PerMigration },
            },
          },
        ],
      },
      queue: {
        default: 'hook-queue',
        routing: {},
        connections: [{ service: 'HookTestQueueClient', name: 'hook-queue', defaultQueueChannel: '/queue/test', defaultTopicChannel: '/topic/test' }],
      },
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    };
  }
}

const trace: string[] = [];
let failEmit = false;
let failHandle = false;

class OuterHook extends QueueMessageHook {
  beforeEmit(message: IQueueMessage): void {
    trace.push('outer.beforeEmit');
    if (failEmit) throw new Error('refused');
    message.Initiator = { type: 'user', id: 'alice' };
  }

  async aroundHandle<T>(_message: IQueueMessage, next: () => Promise<T>): Promise<T> {
    trace.push('outer.in');
    if (failHandle) throw new Error('refused to handle');
    try {
      return await next();
    } finally {
      trace.push('outer.out');
    }
  }
}

class InnerHook extends QueueMessageHook {
  async beforeEmit(): Promise<void> {
    trace.push('inner.beforeEmit');
  }

  async aroundHandle<T>(_message: IQueueMessage, next: () => Promise<T>): Promise<T> {
    trace.push('inner.in');
    try {
      return await next();
    } finally {
      trace.push('inner.out');
    }
  }
}

@Job()
class PlainJob extends QueueJob {
  public RetryCount = 0;

  public async execute() {
    trace.push('execute');
    return 'done';
  }
}

@Job({ runAs: 'system' })
class SystemJob extends QueueJob {
  public async execute() {
    return 'system';
  }
}

async function client() {
  const queue = await DI.resolve(QueueService);
  return queue.get('hook-queue') as unknown as HookTestQueueClient;
}

function uncacheOwn() {
  DI.uncache(Configuration);
  DI.uncache(Orm);
  DI.uncache(QueueService);
  DI.uncache(QueueClient);
  DI.uncache(HookTestQueueClient);
  DI.uncache(OuterHook);
  DI.uncache(InnerHook);
  DI.uncache(Array.ofType(QueueMessageHook));
  DI.uncache(QueueMessageHook);
}

describe('queue message hooks', function () {
  this.timeout(15000);

  beforeEach(async () => {
    // every queue suite starts from an empty cache; the previous file leaves Configuration and the transport behind
    DI.clearCache();
    trace.length = 0;
    failEmit = false;
    failHandle = false;
    DI.register(HookConf).as(Configuration);
    DI.register(OuterHook).as(QueueMessageHook);
    DI.register(InnerHook).as(QueueMessageHook);
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
    // the transport instance outlives a test; start each one with an empty wire
    (await client()).Emitted.length = 0;
  });

  afterEach(async () => {
    DI.unregister(OuterHook);
    DI.unregister(InnerHook);
    uncacheOwn();
  });

  it('@Job() stores only the type; @Job({ runAs }) stores runAs too', () => {
    expect(Reflect.getMetadata('queue:options', PlainJob)).to.deep.equal({ type: 'job' });
    expect(Reflect.getMetadata('queue:options', SystemJob)).to.deep.equal({ type: 'job', runAs: 'system' });
  });

  it('jobOptions returns runAs for a known value and nothing for an unknown one', () => {
    expect(jobOptions(new SystemJob())).to.deep.equal({ runAs: 'system' });
    expect(jobOptions(new PlainJob())).to.deep.equal({});

    @Job({ runAs: 'root' as never })
    class Typo extends QueueJob {
      public async execute() {
        return null;
      }
    }
    expect(jobOptions(new Typo())).to.deep.equal({});
    expect(jobOptions({})).to.deep.equal({});
  });

  it('beforeEmit runs for every hook, in order, before the transport sees the message', async () => {
    await PlainJob.emit({});

    expect(trace).to.deep.equal(['outer.beforeEmit', 'inner.beforeEmit']);
    const c = await client();
    expect(c.Emitted).to.have.length(1);
    expect(c.Emitted[0].Initiator).to.deep.equal({ type: 'user', id: 'alice' });
  });

  it('a throwing beforeEmit makes emit reject and sends nothing', async () => {
    failEmit = true;

    await expect(PlainJob.emit({})).to.be.rejectedWith('refused');

    const c = await client();
    expect(c.Emitted).to.have.length(0);
  });

  it('aroundHandle wraps execute, first hook outermost, and the result reaches the job row', async () => {
    const queue = await DI.resolve(QueueService);
    await queue.consume(PlainJob);
    await PlainJob.emit({});
    trace.length = 0;

    const c = await client();
    await c.deliver(c.Emitted[0]);

    expect(trace).to.deep.equal(['outer.in', 'inner.in', 'execute', 'inner.out', 'outer.out']);
    const row = (await JobModel.all())[0] as JobModel<unknown>;
    expect(row.Status).to.equal('success');
    expect(row.Result).to.equal('done');
  });

  it('the hooks run on the message the consumer hydrated, Initiator included', async () => {
    const seen: unknown[] = [];
    const original = OuterHook.prototype.aroundHandle;
    OuterHook.prototype.aroundHandle = async function <T>(message: IQueueMessage, next: () => Promise<T>): Promise<T> {
      seen.push(message.Initiator);
      return original.call(this, message, next);
    };

    try {
      const queue = await DI.resolve(QueueService);
      await queue.consume(PlainJob);
      await PlainJob.emit({});
      const c = await client();
      await c.deliver(c.Emitted[0]);
    } finally {
      OuterHook.prototype.aroundHandle = original;
    }

    expect(seen).to.deep.equal([{ type: 'user', id: 'alice' }]);
  });

  it('the consumer copies the Initiator onto the job row on first receipt', async () => {
    const queue = await DI.resolve(QueueService);
    await queue.consume(PlainJob);
    await PlainJob.emit({});

    const c = await client();
    await c.deliver(c.Emitted[0]);

    const row = (await JobModel.all())[0] as JobModel<unknown>;
    expect(row.InitiatorType).to.equal('user');
    expect(row.InitiatorId).to.equal('alice');
  });

  it('a redelivery keeps the Initiator of the first receipt', async () => {
    const queue = await DI.resolve(QueueService);
    await queue.consume(PlainJob);
    await PlainJob.emit({});

    const c = await client();
    await c.deliver(c.Emitted[0]);
    await c.deliver({ ...c.Emitted[0], Initiator: { type: 'user', id: 'mallory' } });

    const rows = await JobModel.all();
    expect(rows).to.have.length(1);
    expect((rows[0] as JobModel<unknown>).InitiatorId).to.equal('alice');
  });

  it('a throwing aroundHandle fails the job through the normal failure path', async () => {
    failHandle = true;
    const queue = await DI.resolve(QueueService);
    await queue.consume(PlainJob);
    await PlainJob.emit({});

    const c = await client();
    await expect(c.deliver(c.Emitted[0])).to.be.rejectedWith('refused to handle');

    const row = (await JobModel.all())[0] as JobModel<unknown>;
    expect(row.Status).to.equal('dead');
    expect(row.LastError).to.equal('refused to handle');
    expect(trace).to.not.include('execute');
  });
});

describe('queue without message hooks', function () {
  this.timeout(15000);

  beforeEach(async () => {
    // every queue suite starts from an empty cache; the previous file leaves Configuration and the transport behind
    DI.clearCache();
    trace.length = 0;
    DI.register(HookConf).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
    // the transport instance outlives a test; start each one with an empty wire
    (await client()).Emitted.length = 0;
  });

  afterEach(async () => {
    uncacheOwn();
  });

  it('emits and executes as before', async () => {
    const queue = await DI.resolve(QueueService);
    await queue.consume(PlainJob);
    await PlainJob.emit({});

    const c = await client();
    expect(c.Emitted[0].Initiator).to.equal(undefined);
    await c.deliver(c.Emitted[0]);

    expect(trace).to.deep.equal(['execute']);
    const row = (await JobModel.all())[0] as JobModel<unknown>;
    expect(row.Status).to.equal('success');
    expect(row.InitiatorType ?? null).to.equal(null);
    expect(row.InitiatorId ?? null).to.equal(null);
  });
});

describe('@Job inheritance', () => {
  it('a subclass does not inherit its parent runAs', () => {
    @Job({ runAs: 'system' })
    class Parent extends QueueJob {
      public async execute() {
        return null;
      }
    }
    @Job()
    class Child extends Parent {}

    expect(jobOptions(new Parent())).to.deep.equal({ runAs: 'system' });
    expect(jobOptions(new Child())).to.deep.equal({});
  });
});

let trackingCalls = 0;

class TrackingHook extends QueueTrackingHook {
  async aroundTracking<T>(next: () => Promise<T>): Promise<T> {
    trackingCalls++;
    return next();
  }
}

describe('queue tracking hook', () => {
  beforeEach(async () => {
    DI.clearCache();
    trackingCalls = 0;
    DI.register(HookConf).as(Configuration);
    DI.register(TrackingHook).as(QueueTrackingHook);
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('wraps the job row reads and writes', async () => {
    const queue = await DI.resolve(QueueService);
    await queue.consume(PlainJob);
    await PlainJob.emit({});
    const c = await client();
    await c.deliver(c.Emitted[c.Emitted.length - 1]);

    expect(trackingCalls).to.be.greaterThan(3);
    expect(((await JobModel.all())[0] as JobModel<unknown>).Status).to.equal('success');
  });
});
