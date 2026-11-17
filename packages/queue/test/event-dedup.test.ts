import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Configuration, FrameworkConfiguration, InvalidConfiguration, registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, DI, Injectable, type ContainerSnapshot } from '@spinajs/di';
import { Clock, DbTimeSource, FaultInjector } from '@spinajs/durable';
import { FakeClock } from '@spinajs/durable/testing';
import { IdempotencyInFlight, IdempotencyStore, OrmIdempotencyStore, type IdempotencyClaim, type IdempotencyClaimOptions, type StoredReply } from '@spinajs/idempotency';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import { decideDelivery, Event, QUEUE_CONFIGURATION_SCHEMA, QueueEvent, QueueService, isRedeliverLater, resolveDeliveryPolicy } from '../src/index.js';
import { MemoryBroker, wireCopy } from '../src/testing/index.js';
import { deferred, memoryClientOf, RecordingFaults, faultsHit, T0 } from './support/outbox-env.js';

chai.use(chaiAsPromised);
const { expect } = chai;

@Event()
class PaymentCaptured extends QueueEvent {
  public PaymentId: string;
}

const storeFailures: { claim?: Error; complete?: Error } = {};

/** The real store, failing the next claim or reply write the test arms. */
@Injectable(IdempotencyStore)
class FlakyIdempotencyStore extends OrmIdempotencyStore {
  public async claim(key: string, opts: IdempotencyClaimOptions): Promise<IdempotencyClaim> {
    const failure = storeFailures.claim;
    storeFailures.claim = undefined;
    if (failure) throw failure;
    return super.claim(key, opts);
  }

  public async complete(key: string, token: string, reply: StoredReply, ttlMs: number, now: number): Promise<boolean> {
    const failure = storeFailures.complete;
    storeFailures.complete = undefined;
    if (failure) throw failure;
    return super.complete(key, token, reply, ttlMs, now);
  }
}

interface BootOptions {
  deduplicateEvents?: boolean;
  deduplicate?: boolean;
  // wider than the configuration type: a configuration file can hold null or a boolean
  deduplicateTtl?: string | number | boolean | null;
  deferred?: boolean;
  bootstrap?: boolean;
  store?: string;
  routing?: Record<string, unknown>;
}

// the memory transport drops a failed event by default, so a case that expects the failed delivery again routes it to be retried
const RETRIED = { routing: { PaymentCaptured: { maxRetries: 1, onEventFailure: 'retry' } } };

let brokerSeq = 0;
let current: BootOptions & { brokerName: string } = { brokerName: '' };
let beforeBoot: ContainerSnapshot | undefined;

// One class at module level: DI keeps the first class registered under a name.
class DedupConf extends FrameworkConfiguration {
  protected onLoad() {
    const sqlite = (name: string) => ({ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: name, Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } } });
    return {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
      db: { DefaultConnection: 'app', Aliases: { idempotency: 'app' }, Connections: [sqlite('app'), sqlite('queue')] },
      idempotency: { store: current.store ?? 'OrmIdempotencyStore', lease: '30s' },
      queue: {
        default: 'memory',
        routing: current.routing ?? {},
        ...(current.deduplicate === undefined ? {} : { deduplicate: current.deduplicate }),
        deduplicateEvents: current.deduplicateEvents ?? true,
        deduplicateTtl: current.deduplicateTtl === undefined ? '7d' : current.deduplicateTtl,
        connections: [{ service: 'MemoryQueueClient', name: 'memory', defaultQueueChannel: '/queue/m', defaultTopicChannel: '/topic/m', options: { broker: current.brokerName, deferred: current.deferred ?? true } }],
      },
    };
  }
}

async function boot(options: BootOptions = {}) {
  DI.clearCache();
  beforeBoot ??= DI.snapshot();
  faultsHit.length = 0;
  current = { ...options, brokerName: `dedup-${++brokerSeq}` };
  const clock = new FakeClock(T0);
  const faults = new RecordingFaults();
  DI.register(DedupConf).as(Configuration);
  DI.register(() => clock).as(Clock);
  DI.register(() => clock.dbSource).as(DbTimeSource);
  DI.register(() => faults).as(FaultInjector);
  // as an app boot does: the queue's schemas are registered, so they validate and coerce the configuration
  if (options.bootstrap) {
    for (const bootstrapper of await DI.resolve(Array.ofType(Bootstrapper))) await bootstrapper.bootstrap();
  }
  await DI.resolve(Configuration);
  await (await DI.resolve(Orm)).Migrator.ready();
  const queue = await DI.resolve(QueueService);
  return { queue, client: memoryClientOf(queue, 'memory'), faults, clock };
}

async function teardown(): Promise<void> {
  if (beforeBoot) {
    await DI.restore(beforeBoot);
    beforeBoot = undefined;
  } else {
    await DI.dispose();
  }
  DI.clearCache();
  MemoryBroker.drop(current.brokerName);
}

describe('queue: event deduplication by MessageId', function () {
  // every case boots an Orm with two sqlite connections, which takes seconds on a loaded machine
  this.timeout(120_000);
  afterEach(teardown);

  it('runs the handler once for a duplicate delivery', async () => {
    const env = await boot();
    const handled: string[] = [];
    await env.queue.consume<PaymentCaptured>(PaymentCaptured, async (m) => void handled.push(m.PaymentId), 'ledger');
    const message = new PaymentCaptured({ PaymentId: 'p1', MessageId: '33333333-3333-4333-8333-333333333333' });
    await env.queue.emit(message);
    await env.client.emit(wireCopy(message));
    await env.client.deliverAll();
    expect(handled).to.deep.equal(['p1']);
  });

  it('runs once per subscription', async () => {
    const env = await boot();
    const handled: string[] = [];
    await env.queue.consume<PaymentCaptured>(PaymentCaptured, async () => void handled.push('ledger'), 'ledger');
    await env.queue.consume<PaymentCaptured>(PaymentCaptured, async () => void handled.push('mailer'), 'mailer');
    await env.queue.emit(new PaymentCaptured({ PaymentId: 'p2' }));
    await env.client.deliverAll();
    expect(handled.sort()).to.deep.equal(['ledger', 'mailer']);
  });

  it('releases the key after a handler failure, so the redelivery runs again', async () => {
    const env = await boot(RETRIED);
    let calls = 0;
    await env.queue.consume<PaymentCaptured>(
      PaymentCaptured,
      async () => {
        if (++calls === 1) throw new Error('first try fails');
      },
      'ledger',
    );
    await env.queue.emit(new PaymentCaptured({ PaymentId: 'p3' }));
    await env.client.deliverAll();
    await env.client.deliverAll();
    expect(calls).to.equal(2);
  });

  it('redelivers, never acks, a duplicate that arrives while the first copy is in flight', async () => {
    const env = await boot();
    const blocked = deferred();
    const running = deferred();
    let calls = 0;
    const errors: unknown[] = [];
    await env.queue.consume<PaymentCaptured>(
      PaymentCaptured,
      async () => {
        calls++;
        if (calls === 1) {
          running.resolve();
          await blocked.promise;
        }
      },
      'ledger',
    );
    const message = new PaymentCaptured({ PaymentId: 'p4', MessageId: '44444444-4444-4444-8444-444444444444' });
    const first = env.client.deliver(wireCopy(message));
    await running.promise;
    await env.client.deliver(wireCopy(message)).catch((e: unknown) => errors.push(e));
    blocked.resolve();
    await first;
    expect(calls).to.equal(1);
    expect(errors).to.have.length(1);
    expect(isRedeliverLater(errors[0])).to.equal(true);
    // the route has no retries and drops a failed event, and still the duplicate is redelivered, its count unchanged
    const policy = resolveDeliveryPolicy(env.client, message);
    expect(policy).to.include({ maxRetries: 0, onEventFailure: 'drop' });
    expect(decideDelivery(message, 2, errors[0], policy)).to.include({ action: 'retry', attempt: 2, delayMs: 30_000, forced: true });
  });

  it('handles once when two consumers of one subscription receive the same MessageId at once', async () => {
    const env = await boot();
    const blocked = deferred();
    const firstSettled = deferred();
    const handled: string[] = [];
    const errors: unknown[] = [];
    const handler = (name: string) => async () => {
      handled.push(name);
      await blocked.promise;
    };
    await env.queue.consume<PaymentCaptured>(PaymentCaptured, handler('replica-a'), 'ledger');
    await env.queue.consume<PaymentCaptured>(PaymentCaptured, handler('replica-b'), 'ledger');
    const message = new PaymentCaptured({ PaymentId: 'p8', MessageId: '88888888-8888-4888-8888-888888888888' });
    const consumers = env.client.subscriptions;
    expect(consumers).to.have.length(2);
    // one copy to each consumer, both claims under way before either settles; the winner is held in its handler until
    // the loser has settled
    const deliveries = consumers.map((s) =>
      s
        .callback(wireCopy(message))
        .catch((e: unknown) => void errors.push(e))
        .finally(() => firstSettled.resolve()),
    );
    await firstSettled.promise;
    blocked.resolve();
    await Promise.all(deliveries);
    expect(handled).to.have.length(1);
    expect(errors).to.have.length(1);
    expect(isRedeliverLater(errors[0])).to.equal(true);

    // the redelivery to the consumer that lost is acked without running the handler
    for (const s of consumers) await s.callback(wireCopy(message));
    expect(handled).to.have.length(1);
  });

  it('treats an IdempotencyInFlight the handler throws as a handler failure, not a redelivery', async () => {
    const env = await boot();
    let calls = 0;
    const errors: unknown[] = [];
    await env.queue.consume<PaymentCaptured>(
      PaymentCaptured,
      async () => {
        if (++calls === 1) throw new IdempotencyInFlight(5000);
      },
      'ledger',
    );
    const message = new PaymentCaptured({ PaymentId: 'p11', MessageId: '11111111-1111-4111-8111-111111111111' });
    await env.client.deliver(wireCopy(message)).catch((e: unknown) => errors.push(e));
    expect(errors).to.have.length(1);
    expect(errors[0]).to.be.instanceOf(IdempotencyInFlight);
    expect(isRedeliverLater(errors[0])).to.equal(false);
    // a handler failure: dropped by the default policy, and under retries it is counted and ends in the dead-letter channel
    const policy = resolveDeliveryPolicy(env.client, message);
    expect(decideDelivery(message, 0, errors[0], policy)).to.include({ action: 'ack', dropped: true });
    const retrying = { ...policy, maxRetries: 1, onEventFailure: 'retry' as const };
    expect(decideDelivery(message, 0, errors[0], retrying)).to.deep.include({ action: 'retry', attempt: 1 }).and.not.have.property('forced');
    expect(decideDelivery(message, 1, errors[0], retrying)).to.include({ action: 'dead-letter', reason: 'exhausted' });
    // the key was released, so the retry runs the handler again
    await env.client.deliver(wireCopy(message));
    expect(calls).to.equal(2);
  });

  it('sets deduplication up again for a later subscription after the first setup failed', async () => {
    const env = await boot();
    env.clock.dbSource.read = () => Promise.reject(new Error('database down'));
    await expect(env.queue.consume(PaymentCaptured, async () => undefined, 'ledger')).to.be.rejectedWith(/database down/);
    Reflect.deleteProperty(env.clock.dbSource, 'read');
    let calls = 0;
    await env.queue.consume<PaymentCaptured>(PaymentCaptured, async () => void calls++, 'ledger');
    const message = new PaymentCaptured({ PaymentId: 'p12', MessageId: '12121212-1212-4212-8212-121212121212' });
    await env.client.deliver(wireCopy(message));
    await env.client.deliver(wireCopy(message));
    expect(calls).to.equal(1);
  });

  it('does not deduplicate a subscription without a subscriptionId', async () => {
    const env = await boot();
    let calls = 0;
    await env.queue.consume<PaymentCaptured>(PaymentCaptured, async () => void calls++);
    const message = new PaymentCaptured({ PaymentId: 'p5', MessageId: '55555555-5555-4555-8555-555555555555' });
    await env.client.deliver(wireCopy(message));
    await env.client.deliver(wireCopy(message));
    expect(calls).to.equal(2);
  });

  for (const off of [{ deduplicateEvents: false }, { deduplicate: false }]) {
    it(`does not deduplicate with ${JSON.stringify(off)}`, async () => {
      const env = await boot(off);
      let calls = 0;
      await env.queue.consume<PaymentCaptured>(PaymentCaptured, async () => void calls++, 'ledger');
      const message = new PaymentCaptured({ PaymentId: 'p6', MessageId: '66666666-6666-4666-8666-666666666666' });
      await env.client.deliver(wireCopy(message));
      await env.client.deliver(wireCopy(message));
      expect(calls).to.equal(2);
    });
  }

  it('refuses a deduplicateTtl of zero when the subscription is made, not at the first delivery', async () => {
    const env = await boot({ deduplicateTtl: '0s' });
    await expect(env.queue.consume(PaymentCaptured, async () => undefined, 'ledger')).to.be.rejectedWith(/deduplicateTtl/);
  });

  it('takes a numeric deduplicateTtl through the schema the Bootstrappers register', async () => {
    const env = await boot({ deduplicateTtl: 86_400_000, bootstrap: true });
    let calls = 0;
    await env.queue.consume<PaymentCaptured>(PaymentCaptured, async () => void calls++, 'ledger');
    const message = new PaymentCaptured({ PaymentId: 'p7', MessageId: '77777777-7777-4777-8777-777777777777' });
    await env.queue.emit(message);
    await env.client.emit(wireCopy(message));
    await env.client.deliverAll();
    expect(calls).to.equal(1);
  });

  it('refuses null, a boolean and zero as deduplicateTtl by its schema', async () => {
    for (const deduplicateTtl of [null, true, false, '', 0, '0s']) {
      // dedup is off, so only the schema judges the value
      await boot({ deduplicateEvents: false, deduplicateTtl });
      expect(() => registerConfigurationSchema(QUEUE_CONFIGURATION_SCHEMA, DI.RootContainer), JSON.stringify(deduplicateTtl)).to.throw(InvalidConfiguration, /deduplicateTtl/);
      await teardown();
    }
  });

  it('refuses dedup on a connection that would drop a redelivery', async () => {
    const env = await boot({ deferred: false });
    await expect(env.queue.consume(PaymentCaptured, async () => undefined, 'ledger')).to.be.rejectedWith(/RedeliversFailedEvents/);
  });

  it('calls queue.before-ack after the handler and before the transport settles', async () => {
    const env = await boot();
    let calls = 0;
    await env.queue.consume<PaymentCaptured>(PaymentCaptured, async () => void calls++, 'ledger');
    await env.queue.emit(new PaymentCaptured({ PaymentId: 'p6' }));
    env.faults.crashAt = 'queue.before-ack';
    await env.client.deliverAll();
    env.faults.crashAt = undefined;
    expect(calls).to.equal(1);
    expect(faultsHit.map((f) => f.name)).to.include('queue.before-ack');
    // the crash left the delivery unsettled: the next round delivers it again, and dedup acks it without the handler
    await env.client.deliverAll();
    expect(calls).to.equal(1);
    expect(faultsHit.filter((f) => f.name === 'queue.before-ack')).to.have.length(2);
  });

  it('redelivers an event whose claim fails, and runs it again after its reply could not be stored', async () => {
    const env = await boot({ ...RETRIED, store: FlakyIdempotencyStore.name });
    const handled: string[] = [];
    await env.queue.consume<PaymentCaptured>(PaymentCaptured, async (m) => void handled.push(m.PaymentId), 'ledger');

    storeFailures.claim = new Error('database unavailable');
    await env.queue.emit(new PaymentCaptured({ PaymentId: 'p9' }));
    await env.client.deliverAll();
    expect(handled).to.deep.equal([]);
    await env.client.deliverAll();
    expect(handled).to.deep.equal(['p9']);

    storeFailures.complete = new Error('database unavailable');
    const message = new PaymentCaptured({ PaymentId: 'p10', MessageId: '10101010-1010-4010-8010-101010101010' });
    await env.queue.emit(message);
    await env.client.deliverAll();
    expect(handled).to.deep.equal(['p9', 'p10']);
    // the handler's work is done, so the delivery was acked; nothing remembers it, so a duplicate runs it again
    await env.client.emit(wireCopy(message));
    await env.client.deliverAll();
    expect(handled).to.deep.equal(['p9', 'p10', 'p10']);
  });
});
