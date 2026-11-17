import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';
import { OutboxRelay, OutboxStore, type IQueueOutboxConfig, type OutboxRelayOptions } from '../src/index.js';
import { bootOutbox, broker, deferred, disposeOutbox, OrderPlaced, outboxRows, T0, TestCrash, type OutboxEnv } from './support/outbox-env.js';

chai.use(chaiAsPromised);
const { expect } = chai;

const relay = (replicaId = 'r1') => DI.resolve(OutboxRelay, [{ replicaId, autoStart: false, random: () => 0.5 }]);
const FIXED: Partial<IQueueOutboxConfig> = { backoff: { backoff: 'fixed', delay: 1000 } };
const DAY = 86_400_000;

interface StoreSwapOptions extends OutboxRelayOptions {
  store: (driver: OrmDriver) => OutboxStore;
}

class StoreSwapFailureRelay extends OutboxRelay {
  constructor(protected readonly swap: StoreSwapOptions) {
    super(swap);
  }

  public async resolve(): Promise<void> {
    await super.resolve();
    for (const [connection, store] of this.stores) this.stores.set(connection, this.swap.store(store.driver));
  }
}

const published = (MessageId: string, PublishedAt: number | null, Status = 'published') => ({ MessageId, Name: 'OrderPlaced', Type: 'EVENT', Message: '{}', Status, Attempts: 0, AvailableAt: 0, CreatedAt: 0, PublishedAt, ClaimEpoch: 0 });

async function insertRows(env: OutboxEnv, rows: ReturnType<typeof published>[]): Promise<void> {
  for (const row of rows) await env.orders.insert().into('queue_outbox').values(row);
}

async function messageIds(env: OutboxEnv): Promise<string[]> {
  return (await outboxRows(env.orders)).map((r) => r.MessageId).sort();
}

describe('queue outbox: failures and retention', function () {
  // every case boots an Orm with three sqlite connections, which takes tens of seconds on a loaded machine
  this.timeout(120_000);
  afterEach(disposeOutbox);

  it('backs off a failed publish and retries it once it is due', async () => {
    const env = await bootOutbox({ outbox: FIXED });
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '1' })));
    broker.failures.set('bus-a', [new Error('broker down')]);
    const r = await relay();
    await r.tick();
    let [row] = await outboxRows(env.orders);
    expect(row).to.include({ Status: 'pending', Attempts: 1, AvailableAt: T0 + 1000, LastError: 'broker down', ClaimedBy: null });
    await r.tick();
    expect(broker.sent).to.have.length(0);
    env.clock.set(T0 + 1000);
    await r.tick();
    [row] = await outboxRows(env.orders);
    expect(row.Status).to.equal('published');
    expect(broker.sent).to.have.length(1);
  });

  it('keeps retrying through a broker outage shorter than maxAge, whatever the number of attempts', async () => {
    const env = await bootOutbox({ outbox: FIXED });
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '1' })));
    broker.failures.set('bus-a', Array.from({ length: 30 }, (_, i) => new Error(`down ${i}`)));
    const r = await relay();
    // 30 failures over 90 minutes; the default maxAge is 24 h
    for (let i = 0; i < 30; i++) {
      env.clock.set(T0 + i * 180_000);
      await r.tick();
    }
    expect((await outboxRows(env.orders))[0]).to.include({ Status: 'pending', Attempts: 30, LastError: 'down 29' });
    env.clock.set(T0 + 30 * 180_000);
    await r.tick();
    expect((await outboxRows(env.orders))[0].Status).to.equal('published');
    expect(broker.sent).to.have.length(1);
  });

  it('marks a row dead at the first failure once it is maxAge old, and never retries it', async () => {
    const env = await bootOutbox({ outbox: { ...FIXED, maxAge: '1h' } });
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '1' })));
    broker.failures.set('bus-a', [new Error('one'), new Error('two'), new Error('three'), new Error('four')]);
    const r = await relay();
    await r.tick();
    env.clock.set(T0 + 3_599_999);
    await r.tick();
    expect((await outboxRows(env.orders))[0]).to.include({ Status: 'pending', Attempts: 2, LastError: 'two' });
    env.clock.set(T0 + 3_600_999);
    await r.tick();
    const [row] = await outboxRows(env.orders);
    expect(row).to.include({ Status: 'dead', Attempts: 3, LastError: 'three', ClaimedBy: null });
    env.clock.set(T0 + 7_200_000);
    await r.tick();
    expect(broker.failures.get('bus-a')).to.have.length(1);
    expect(broker.sent).to.deep.equal([]);
  });

  it('counts maxAge from CreatedAt: a failure one millisecond before it retries, a failure at it is dead', async () => {
    const env = await bootOutbox({ outbox: { backoff: { backoff: 'fixed', delay: 0 }, maxAge: '1h' } });
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '1' })));
    broker.failures.set('bus-a', [new Error('one'), new Error('two')]);
    const r = await relay();
    env.clock.set(T0 + 3_599_999);
    await r.tick();
    expect((await outboxRows(env.orders))[0]).to.include({ Status: 'pending', Attempts: 1, AvailableAt: T0 + 3_599_999 });
    env.clock.set(T0 + 3_600_000);
    await r.tick();
    expect((await outboxRows(env.orders))[0]).to.include({ Status: 'dead', Attempts: 2, LastError: 'two' });
  });

  it('remembers the connections that confirmed and retries only the others', async () => {
    const env = await bootOutbox({ outbox: FIXED, routing: { OrderPlaced: [{ connection: 'bus-a' }, { connection: 'bus-b' }] } });
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '1' })));
    broker.failures.set('bus-b', [new Error('b down')]);
    const r = await relay();
    await r.tick();
    expect((await outboxRows(env.orders))[0].PublishedTo).to.deep.equal(['bus-a']);
    env.clock.set(T0 + 1000);
    await r.tick();
    expect(broker.sent.map((s) => s.connection)).to.deep.equal(['bus-a', 'bus-b']);
    expect((await outboxRows(env.orders))[0]).to.deep.include({ Status: 'published', PublishedTo: ['bus-a', 'bus-b'] });
  });

  it('sends to a connection that confirmed once, however long another connection keeps failing', async () => {
    const env = await bootOutbox({ outbox: FIXED, routing: { OrderPlaced: [{ connection: 'bus-a' }, { connection: 'bus-b' }] } });
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '1' })));
    broker.failures.set('bus-b', [new Error('b down 1'), new Error('b down 2'), new Error('b down 3')]);
    const r = await relay();
    for (let i = 0; i < 6; i++) {
      env.clock.set(T0 + i * 1000);
      await r.tick();
    }
    expect(broker.sent.map((s) => s.connection)).to.deep.equal(['bus-a', 'bus-b']);
    expect((await outboxRows(env.orders))[0]).to.include({ Status: 'published', Attempts: 3 });
  });

  it('a relay that lost its claim records nothing of its failed publish, and leaves the row to the new owner', async () => {
    const env = await bootOutbox({ outbox: { ...FIXED, claimTtl: 30_000, maxPublishMs: 10_000 } });
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '1' })));
    const staleGate = deferred();
    const staleReached = deferred();
    broker.gate = staleGate.promise;
    broker.onEmit = () => staleReached.resolve();
    const stale = (await relay('r1')).tick();
    await staleReached.promise;

    const ownerGate = deferred();
    const ownerReached = deferred();
    broker.gate = ownerGate.promise;
    broker.onEmit = () => ownerReached.resolve();
    env.clock.set(T0 + 31_000);
    const owner = (await relay('r2')).tick();
    await ownerReached.promise;

    broker.failures.set('bus-a', [new Error('broker down')]);
    staleGate.resolve();
    await stale;
    expect((await outboxRows(env.orders))[0]).to.include({ Status: 'pending', ClaimedBy: 'r2', ClaimEpoch: 2, ClaimedUntil: T0 + 61_000, Attempts: 0, LastError: null });

    ownerGate.resolve();
    await owner;
    expect((await outboxRows(env.orders))[0]).to.include({ Status: 'published', ClaimedBy: null, Attempts: 0 });
    expect(broker.sent).to.have.length(1);
  });

  it('rethrows a crash from the broker without writing the failure', async () => {
    const env = await bootOutbox({ outbox: FIXED });
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '1' })));
    broker.failures.set('bus-a', [new TestCrash('process died')]);
    await expect((await relay()).tick()).to.be.rejectedWith('process died');
    expect((await outboxRows(env.orders))[0]).to.include({ Status: 'pending', Attempts: 0, ClaimedBy: 'r1' });
  });

  it('purges published rows past retention in batches, and keeps newer and dead rows', async () => {
    const env = await bootOutbox({ outbox: { retention: '1d', batchSize: 100 } });
    const old = Array.from({ length: 250 }, (_, i) => published(`old-${i}`, T0 - 2 * DAY));
    await insertRows(env, [...old, published('fresh', T0 - 1000), published('dead', null, 'dead')]);
    await (await relay()).tick();
    expect(await messageIds(env)).to.deep.equal(['dead', 'fresh']);
  });

  it('keeps a row published exactly retention ago, and purges again only once retention / 100 has passed', async () => {
    const env = await bootOutbox({ outbox: { retention: '1d' } });
    await insertRows(env, [published('at-retention', T0 - DAY), published('past-retention', T0 - DAY - 1)]);
    const r = await relay();
    await r.tick();
    expect(await messageIds(env)).to.deep.equal(['at-retention']);
    // retention / 100 of a day is 864 s
    env.clock.set(T0 + 863_999);
    await r.tick();
    expect(await messageIds(env)).to.deep.equal(['at-retention']);
    env.clock.set(T0 + 864_000);
    await r.tick();
    expect(await messageIds(env)).to.deep.equal([]);
  });

  it('keeps a row re-driven between the purge select and its delete', async () => {
    const env = await bootOutbox({ outbox: { retention: '1d' } });
    await insertRows(env, [published('a', T0 - 2 * DAY), published('b', T0 - 2 * DAY), published('c', T0 - 2 * DAY)]);
    class RedriveDuringPurge extends OutboxStore {
      protected async purgeCandidates(before: number, limit: number): Promise<number[]> {
        const ids = await super.purgeCandidates(before, limit);
        await this.driver.update().in('queue_outbox').update({ Status: 'pending', AvailableAt: 0, PublishedAt: null }).where('MessageId', 'b');
        return ids;
      }
    }
    expect(await new RedriveDuringPurge(env.orders).purgePublished(T0 - DAY, 100)).to.equal(2);
    expect(await messageIds(env)).to.deep.equal(['b']);
  });

  it('ends a purge at a batch that deletes nothing', async () => {
    const env = await bootOutbox({ outbox: { retention: '1d', batchSize: 2 } });
    await insertRows(env, [published('fresh-1', T0), published('fresh-2', T0)]);
    let selects = 0;
    // a select whose rows no longer match by the time of the delete, every time
    class StaleCandidates extends OutboxStore {
      protected async purgeCandidates(_before: number, limit: number): Promise<number[]> {
        if (++selects > 3) throw new Error('the purge does not stop');
        const rows = await this.driver.select<Array<{ Id: number }>>().from('queue_outbox').columns(['Id']).take(limit);
        return rows.map((row) => Number(row.Id));
      }
    }
    const r = await DI.resolve(StoreSwapFailureRelay, [{ replicaId: 'r1', autoStart: false, store: (driver: OrmDriver) => new StaleCandidates(driver) }]);
    await r.tick();
    // one select on each of the two outbox connections
    expect(selects).to.equal(2);
    expect(await messageIds(env)).to.deep.equal(['fresh-1', 'fresh-2']);
  });
});
