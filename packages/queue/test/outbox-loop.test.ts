import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { ev, OutboxRelay, QueueService } from '../src/index.js';
import { bootOutbox, bootOutboxDb, broker, deferred, disposeOutbox, eventually, orderIdOf, OrderPlaced, outboxRows, T0, TestCrash, type OutboxEnv } from './support/outbox-env.js';

chai.use(chaiAsPromised);
const { expect } = chai;

class CountingRelay extends OutboxRelay {
  public static passes = 0;

  protected async pass(): Promise<void> {
    CountingRelay.passes++;
    await super.pass();
  }
}

const countPasses = (): void => {
  CountingRelay.passes = 0;
  DI.register(CountingRelay).as(OutboxRelay);
};

/** Rejections nobody handled while the case ran: a timer callback that lets one escape would reach the process. */
function unhandledRejections(): { reasons: unknown[]; restore: () => void } {
  const reasons: unknown[] = [];
  const record = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on('unhandledRejection', record);
  return { reasons, restore: () => process.off('unhandledRejection', record) };
}

async function holdFirstPublish(env: OutboxEnv): Promise<{ release: () => void }> {
  const gate = deferred();
  const publishing = deferred();
  broker.gate = gate.promise;
  broker.onEmit = () => publishing.resolve();
  await env.clock.advance(0);
  await publishing.promise;
  broker.onEmit = undefined;
  return {
    release: () => {
      broker.gate = undefined;
      gate.resolve();
    },
  };
}

describe('queue outbox: relay loop and after-commit nudge', function () {
  // every case boots an Orm with three sqlite connections, which takes tens of seconds on a loaded machine
  this.timeout(120_000);
  afterEach(disposeOutbox);

  it('publishes right after commit when the service runs the relay', async () => {
    const env = await bootOutbox({ outbox: { relay: true } });
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '1' })));
    await env.clock.advance(0);
    await (await DI.resolve(OutboxRelay)).drained();
    expect(broker.sent).to.have.length(1);
    expect((await outboxRows(env.orders))[0].Status).to.equal('published');
  });

  it('nudges once per emit that commits, not for a rolled-back savepoint', async () => {
    const env = await bootOutbox({ outbox: { relay: true } });
    const relay = await DI.resolve(OutboxRelay);
    const nudged: string[] = [];
    const nudge = relay.nudge.bind(relay);
    relay.nudge = (connection: string): void => {
      nudged.push(connection);
      nudge(connection);
    };
    await env.orders.transaction(async () => {
      await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: 'kept' })));
      await expect(
        env.orders.transaction(async () => {
          await env.queue.emit(new OrderPlaced({ OrderId: 'dropped' }));
          throw new Error('inner');
        }),
      ).to.be.rejectedWith('inner');
      expect(nudged).to.deep.equal([]);
    });
    expect(nudged).to.deep.equal(['orders']);
    await env.clock.advance(0);
    await relay.drained();
    expect(broker.sent.map((s) => orderIdOf(s.message))).to.deep.equal(['kept']);
  });

  it('runs one pass for many emits that commit in one transaction', async () => {
    const env = await bootOutbox({ outbox: { relay: true }, register: countPasses });
    await env.orders.transaction(async () => {
      for (let i = 1; i <= 5; i++) await env.queue.emit(new OrderPlaced({ OrderId: String(i) }));
    });
    expect(env.clock.pendingTimers).to.equal(1);
    await env.clock.advance(0);
    await (await DI.resolve(OutboxRelay)).drained();
    expect(CountingRelay.passes).to.equal(1);
    expect(broker.sent.map((s) => orderIdOf(s.message))).to.deep.equal(['1', '2', '3', '4', '5']);
  });

  it('runs one more pass for a commit that lands while a pass is in flight', async () => {
    const env = await bootOutbox({ outbox: { relay: true, tick: 60_000 } });
    const relay = await DI.resolve(OutboxRelay);
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '1' })));
    const held = await holdFirstPublish(env);
    // the pass has read its due rows and is publishing row 1
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '2' })));
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '3' })));
    // a real clock fires a 0 ms timer here, while the pass is still out: a nudge that only armed one would join that pass
    expect(env.clock.pendingTimers).to.equal(0);
    await env.clock.advance(0);
    held.release();
    await relay.drained();
    expect(broker.sent.map((s) => orderIdOf(s.message))).to.deep.equal(['1']);
    // no simulated time passes: the next scheduled tick is 60 s away
    await env.clock.advance(0);
    await relay.drained();
    expect(broker.sent.map((s) => orderIdOf(s.message))).to.deep.equal(['1', '2', '3']);
    expect(env.clock.pendingTimers).to.equal(1);
  });

  it('never runs two passes at once when a pass outlasts queue.outbox.tick', async () => {
    const env = await bootOutbox({ outbox: { relay: true, tick: 1000 }, register: countPasses });
    const relay = await DI.resolve(OutboxRelay);
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '1' })));
    const held = await holdFirstPublish(env);
    await env.clock.advance(5000);
    expect(env.clock.pendingTimers).to.equal(0);
    expect(CountingRelay.passes).to.equal(1);
    held.release();
    await relay.drained();
    // the next pass is armed only once this one ended, a full tick later
    expect(env.clock.pendingTimers).to.equal(1);
    await env.clock.advance(999);
    expect(CountingRelay.passes).to.equal(1);
    await env.clock.advance(1);
    await relay.drained();
    expect(CountingRelay.passes).to.equal(2);
  });

  it('starts the relay when the Orm boots, without an emit', async () => {
    const db = await bootOutboxDb({ bootstrap: true, outbox: { relay: true } });
    await eventually(() => db.clock.pendingTimers === 1);
    expect(broker.sent).to.deep.equal([]);
  });

  it('ticks again after queue.outbox.tick without a nudge', async () => {
    const env = await bootOutbox({ outbox: { relay: true, tick: 1000 } });
    const relay = await DI.resolve(OutboxRelay);
    await env.clock.advance(0);
    await relay.drained();
    // written behind the relay's back: no emit, so no nudge; only the next scheduled tick finds it
    await env.orders
      .insert()
      .into('queue_outbox')
      .values({ MessageId: 'late', Name: 'OrderPlaced', Type: 'EVENT', Message: JSON.stringify(new OrderPlaced({ OrderId: 'late', MessageId: 'late' })), Status: 'pending', Attempts: 0, AvailableAt: 0, CreatedAt: 0, ClaimEpoch: 0 });
    await env.clock.advance(999);
    await relay.drained();
    expect(broker.sent).to.deep.equal([]);
    await env.clock.advance(1);
    await relay.drained();
    expect(broker.sent.map((s) => orderIdOf(s.message))).to.deep.equal(['late']);
  });

  it('starts no loop with relay: false', async () => {
    const env = await bootOutbox({ outbox: { relay: false } });
    expect(env.clock.pendingTimers).to.equal(0);
  });

  it('keeps the loop going after a pass that throws, and after a broker outage', async () => {
    const env = await bootOutbox({ outbox: { relay: true, tick: 1000, backoff: { backoff: 'fixed', delay: 1000 } } });
    const relay = await DI.resolve(OutboxRelay);
    const unhandled = unhandledRejections();
    try {
      await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '1' })));
      // the database is down: the pass fails before it reads a row
      env.clock.dbSource.read = () => Promise.reject(new Error('database down'));
      await env.clock.advance(0);
      await relay.drained().catch(() => undefined);
      expect(broker.sent).to.deep.equal([]);
      expect(env.clock.pendingTimers).to.equal(1);

      Reflect.deleteProperty(env.clock.dbSource, 'read');
      broker.failures.set('bus-a', [new Error('broker down')]);
      await env.clock.advance(1000);
      await relay.drained();
      expect((await outboxRows(env.orders))[0]).to.include({ Status: 'pending', Attempts: 1, LastError: 'broker down' });

      await env.clock.advance(1000);
      await relay.drained();
      expect(broker.sent.map((s) => orderIdOf(s.message))).to.deep.equal(['1']);
      expect(env.clock.pendingTimers).to.equal(1);
      expect(unhandled.reasons).to.deep.equal([]);
    } finally {
      unhandled.restore();
    }
  });

  it('stops the loop after a crash', async () => {
    const env = await bootOutbox({ outbox: { relay: true } });
    const unhandled = unhandledRejections();
    try {
      broker.failures.set('bus-a', [new TestCrash('died')]);
      await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '1' })));
      await env.clock.advance(0);
      await (await DI.resolve(OutboxRelay)).drained().catch(() => undefined);
      expect(env.clock.pendingTimers).to.equal(0);
      expect((await outboxRows(env.orders))[0]).to.include({ Status: 'pending', Attempts: 0 });
      expect(unhandled.reasons).to.deep.equal([]);
    } finally {
      unhandled.restore();
    }
  });

  it('stops the loop when the queue service is disposed', async () => {
    const env = await bootOutbox({ outbox: { relay: true } });
    expect(env.clock.pendingTimers).to.equal(1);
    await disposeOutbox();
    expect(env.clock.pendingTimers).to.equal(0);
  });

  it('on stop, finishes the publish in flight, releases the rows it has not reached and arms nothing', async () => {
    const env = await bootOutbox({ outbox: { relay: true } });
    const relay = await DI.resolve(OutboxRelay);
    await env.orders.transaction(async () => {
      for (let i = 1; i <= 3; i++) await env.queue.emit(new OrderPlaced({ OrderId: String(i) }));
    });
    const held = await holdFirstPublish(env);
    const stopped = relay.stop();
    held.release();
    await stopped;
    expect(broker.sent.map((s) => orderIdOf(s.message))).to.deep.equal(['1']);
    const rows = await outboxRows(env.orders);
    expect(rows.map((r) => [r.Status, r.ClaimedBy])).to.deep.equal([
      ['published', null],
      ['pending', null],
      ['pending', null],
    ]);
    // a commit after stop nudges nothing
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '4' })));
    relay.nudge('orders');
    expect(env.clock.pendingTimers).to.equal(0);
  });

  it('stops within claimTtl when the publish in flight hangs', async () => {
    const env = await bootOutbox({ outbox: { relay: true, claimTtl: 30_000, maxPublishMs: 10_000 } });
    const relay = await DI.resolve(OutboxRelay);
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '1' })));
    const held = await holdFirstPublish(env);
    let stopped = false;
    const stopping = relay.stop().then(() => (stopped = true));
    await env.clock.advance(29_999);
    expect(stopped).to.equal(false);
    await env.clock.advance(1);
    await stopping;
    expect(env.clock.pendingTimers).to.equal(0);
    // the hung publish returns after all; its claim was not taken over, so the mark stands
    held.release();
    await relay.drained();
    expect((await outboxRows(env.orders))[0]).to.include({ Status: 'published', ClaimedBy: null });
  });

  it('runs one loop per relay: a second start() arms nothing, a second relay drains the same rows without a duplicate', async () => {
    const env = await bootOutbox({ outbox: { relay: true } });
    const relay = await DI.resolve(OutboxRelay);
    relay.start();
    expect(env.clock.pendingTimers).to.equal(1);
    const second = await DI.resolve(OutboxRelay, [{ replicaId: 'second' }]);
    expect(env.clock.pendingTimers).to.equal(2);
    await env.orders.transaction(async () => {
      for (let i = 1; i <= 4; i++) await env.queue.emit(new OrderPlaced({ OrderId: String(i) }));
    });
    await env.clock.advance(0);
    await Promise.all([relay.drained(), second.drained()]);
    expect(broker.sent.map((s) => orderIdOf(s.message)).sort()).to.deep.equal(['1', '2', '3', '4']);
    expect((await outboxRows(env.orders)).every((r) => r.Status === 'published')).to.equal(true);
    await second.stop();
  });

  it('runs the loop outside the transaction in which the queue service was first resolved', async () => {
    const db = await bootOutboxDb({ outbox: { relay: true, tick: 20 }, realTimers: true });
    const inTransaction: boolean[] = [];
    broker.onEmit = () => inTransaction.push(db.orders.CurrentTransaction !== undefined);
    // the first use of the queue in this process: QueueService and its relay resolve inside the transaction
    await db.orders.transaction(() => ev(new OrderPlaced({ OrderId: '1' })));
    await eventually(async () => (await outboxRows(db.orders)).some((row) => row.Status === 'published'));
    expect(inTransaction).to.deep.equal([false]);
  });

  it('nudges at once in always mode outside a transaction', async () => {
    const env = await bootOutbox({ outbox: { relay: true, mode: 'always' } });
    await env.queue.emit(new OrderPlaced({ OrderId: '1' }));
    await env.clock.advance(0);
    await (await DI.resolve(OutboxRelay)).drained();
    expect(broker.sent).to.have.length(1);
  });

  it('re-reads database time in an emit-only process at most once a minute, outside the emitting transaction', async () => {
    const env = await bootOutbox({ outbox: { relay: false } });
    const readInTransaction: boolean[] = [];
    const read = env.clock.dbSource.read.bind(env.clock.dbSource);
    env.clock.dbSource.read = () => {
      readInTransaction.push(env.orders.CurrentTransaction !== undefined);
      return read();
    };
    env.clock.dbSkewMs = 5_000;
    env.clock.set(T0 + 59_999);
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: 'within' })));
    env.clock.set(T0 + 60_000);
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: 'stale' })));
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: 'after' })));
    const rows = await outboxRows(env.orders);
    expect([rows[0].CreatedAt, rows[2].CreatedAt]).to.deep.equal([T0 + 59_999, T0 + 65_000]);
    expect(readInTransaction).to.deep.equal([false]);
    expect(env.clock.pendingTimers).to.equal(0);
  });

  it('names db.DefaultConnection when the queue service cannot read database time', async () => {
    const db = await bootOutboxDb({ outbox: { relay: false } });
    db.clock.dbSource.read = () => Promise.reject(new Error('durable: ORM connection "default" not found'));
    await expect(DI.resolve(QueueService)).to.be.rejectedWith(InvalidOperation, /database time could not be read.*db\.DefaultConnection/);
  });
});
