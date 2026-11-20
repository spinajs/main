import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import type { FakeClock } from '@spinajs/durable/testing';
import type { Log } from '@spinajs/log';
import type { OrmDriver } from '@spinajs/orm';
import { OutboxRelay, OutboxStore, type OutboxClaim, type OutboxRelayOptions, type OutboxRow } from '../src/index.js';
import { bootOutbox, broker, deferred, disposeOutbox, faultsHit, orderIdOf, OrderPlaced, outboxRows, T0, TestCrash, type OutboxEnv } from './support/outbox-env.js';

chai.use(chaiAsPromised);
const { expect } = chai;

async function emitCommitted(env: OutboxEnv, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: String(i) })));
}

const relay = (replicaId: string) => DI.resolve(OutboxRelay, [{ replicaId, autoStart: false }]);

interface StoreSwapOptions extends OutboxRelayOptions {
  store: (driver: OrmDriver) => OutboxStore;
}

class StoreSwapRelay extends OutboxRelay {
  constructor(protected readonly swap: StoreSwapOptions) {
    super(swap);
  }

  public async resolve(): Promise<void> {
    await super.resolve();
    for (const [connection, store] of this.stores) this.stores.set(connection, this.swap.store(store.driver));
  }
}

class LoggedRelay extends OutboxRelay {
  public get queueLog(): Log {
    return this.Log;
  }
}

const MARK_REFUSED = 'Outbox row ${messageId} on ${connection} lost its claim while publishing; another relay may publish it again';
const FAILURE_REFUSED = 'Publishing outbox row ${messageId} failed after the row was claimed by another relay; the failure is not recorded';
const RELEASE_REFUSED = 'Outbox row ${messageId} on ${connection} was claimed by another relay before this one reached it';

/** Records the message template of every warning until `restore()`. */
function spyWarnings(log: Log): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  log.warn = (...args: unknown[]) => {
    messages.push(typeof args[1] === 'string' ? args[1] : '');
  };
  return { messages, restore: () => Reflect.deleteProperty(log, 'warn') };
}

interface TakeOver {
  resumeStale(): Promise<void>;
  resumeOwner(): Promise<void>;
}

/** `stale` claims every row and is held on its first publish; r2 takes the rows over at +31 s and is held on its first publish too. */
async function takeOver(env: OutboxEnv, stale: OutboxRelay): Promise<TakeOver> {
  const staleGate = deferred();
  const staleReached = deferred();
  broker.gate = staleGate.promise;
  broker.onEmit = () => staleReached.resolve();
  const staleTick = stale.tick();
  await staleReached.promise;

  const ownerGate = deferred();
  const ownerReached = deferred();
  broker.gate = ownerGate.promise;
  broker.onEmit = () => ownerReached.resolve();
  env.clock.set(T0 + 31_000);
  const ownerTick = (await relay('r2')).tick();
  await ownerReached.promise;
  return {
    resumeStale: () => {
      staleGate.resolve();
      return staleTick;
    },
    resumeOwner: () => {
      ownerGate.resolve();
      return ownerTick;
    },
  };
}

/** A database that takes `readMs` to read the due rows and `claimMs` for each claim. */
class SlowStore extends OutboxStore {
  constructor(
    driver: OrmDriver,
    protected readonly clock: FakeClock,
    protected readonly readMs: number,
    protected readonly claimMs: number,
  ) {
    super(driver);
  }

  public async due(now: number, limit: number): Promise<OutboxRow[]> {
    const rows = await super.due(now, limit);
    this.clock.set(this.clock.now() + this.readMs);
    return rows;
  }

  public async claim(row: OutboxRow, owner: string, ttlMs: number, now: number): Promise<OutboxClaim | null> {
    const claim = await super.claim(row, owner, ttlMs, now);
    this.clock.set(this.clock.now() + this.claimMs);
    return claim;
  }
}

describe('queue outbox: relay claim, publish, mark', function () {
  // every case boots an Orm with three sqlite connections, which takes tens of seconds on a loaded machine
  this.timeout(120_000);
  afterEach(disposeOutbox);

  it('publishes committed rows and marks them published; one relay without failures keeps Id order', async () => {
    const env = await bootOutbox();
    await emitCommitted(env, 3);
    await (await relay('r1')).tick();
    expect(broker.sent.map((s) => orderIdOf(s.message))).to.deep.equal(['1', '2', '3']);
    const rows = await outboxRows(env.orders);
    expect(rows.map((r) => [r.Status, r.PublishedAt, r.ClaimedBy, r.ClaimEpoch])).to.deep.equal([
      ['published', T0, null, 1],
      ['published', T0, null, 1],
      ['published', T0, null, 1],
    ]);
    expect(rows[0].PublishedTo).to.deep.equal(['bus-a']);
    expect(faultsHit.filter((f) => f.name !== 'outbox.after-insert').map((f) => f.name)).to.deep.equal(['outbox.after-publish', 'outbox.before-mark', 'outbox.after-publish', 'outbox.before-mark', 'outbox.after-publish', 'outbox.before-mark']);
  });

  it('drains every configured connection', async () => {
    const env = await bootOutbox();
    await env.billing.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: 'b' })));
    await emitCommitted(env, 1);
    await (await relay('r1')).tick();
    expect(broker.sent).to.have.length(2);
  });

  it('leaves rows another relay holds alone', async () => {
    const env = await bootOutbox({ outbox: { batchSize: 2 } });
    await emitCommitted(env, 4);
    const gate = deferred();
    const reached = deferred();
    broker.gate = gate.promise;
    broker.onEmit = () => reached.resolve();
    const first = (await relay('r1')).tick();
    await reached.promise;
    broker.onEmit = undefined;
    broker.gate = undefined;
    await (await relay('r2')).tick();
    gate.resolve();
    await first;
    const rows = await outboxRows(env.orders);
    expect(rows.every((r) => r.Status === 'published')).to.equal(true);
    expect(new Set(broker.sent.map((s) => s.message.MessageId)).size).to.equal(4);
    expect(broker.sent).to.have.length(4);
  });

  it('gives a row both relays read to one of them', async () => {
    const env = await bootOutbox();
    await emitCommitted(env, 1);
    const store = new OutboxStore(env.orders);
    const [seenByR1] = await store.due(T0, 10);
    const [seenByR2] = await store.due(T0, 10);
    expect(await store.claim(seenByR1, 'r1', 30_000, T0)).to.include({ owner: 'r1', epoch: 1 });
    expect(await store.claim(seenByR2, 'r2', 30_000, T0)).to.equal(null);
  });

  it('a relay that lost its claim cannot mark the row; the row is published twice, marked once', async () => {
    const env = await bootOutbox({ outbox: { claimTtl: 30_000, maxPublishMs: 10_000 } });
    await emitCommitted(env, 1);
    const gate = deferred();
    const reached = deferred();
    broker.gate = gate.promise;
    broker.onEmit = () => reached.resolve();
    const stale = (await relay('r1')).tick();
    await reached.promise;
    broker.onEmit = undefined;
    broker.gate = undefined;
    env.clock.set(T0 + 31_000);
    await (await relay('r2')).tick();
    // an unfenced mark by r1 would now overwrite PublishedAt
    env.clock.set(T0 + 32_000);
    gate.resolve();
    await stale;
    const [row] = await outboxRows(env.orders);
    expect(row).to.include({ Status: 'published', ClaimedBy: null, ClaimEpoch: 2, PublishedAt: T0 + 31_000 });
    expect(broker.sent).to.have.length(2);
  });

  it('releases the rows of a batch its claim can no longer cover', async () => {
    const env = await bootOutbox({ outbox: { claimTtl: 30_000, maxPublishMs: 10_000 } });
    await emitCommitted(env, 5);
    broker.onEmit = () => env.clock.set(env.clock.now() + 12_000);
    await (await relay('r1')).tick();
    const rows = await outboxRows(env.orders);
    // the claim ends at +30 s. Row 1 starts at +0 (0 + 10 <= 30), row 2 at +12 s (22 <= 30); at +24 s, 24 + 10 > 30,
    // so rows 3..5 are released unpublished
    expect(rows.map((r) => r.Status)).to.deep.equal(['published', 'published', 'pending', 'pending', 'pending']);
    expect(rows.slice(2).every((r) => r.ClaimedBy === null && r.ClaimedUntil === null && r.ClaimEpoch === 1)).to.equal(true);
    expect(broker.sent).to.have.length(2);
  });

  it('loses the claim on a row another relay claimed after it was read, even once that relay let it go', async () => {
    const env = await bootOutbox();
    await emitCommitted(env, 1);
    const store = new OutboxStore(env.orders);
    const [stale] = await store.due(T0, 10);
    const other = await store.claim(stale, 'r2', 30_000, T0);
    if (!other) throw new Error('r2 did not get the claim');
    await store.release(other);
    // the row is free again, but r2's claim moved the epoch, so what r1 read is out of date
    expect(await store.claim(stale, 'r1', 30_000, T0)).to.equal(null);
    const [fresh] = await store.due(T0, 10);
    expect(await store.claim(fresh, 'r1', 30_000, T0)).to.include({ owner: 'r1', epoch: 2, until: T0 + 30_000 });
  });

  it('skips rows whose AvailableAt is in the future', async () => {
    const env = await bootOutbox();
    await emitCommitted(env, 1);
    await env.orders.update().in('queue_outbox').update({ AvailableAt: T0 + 5_000 }).where('Status', 'pending');
    await (await relay('r1')).tick();
    expect(broker.sent).to.deep.equal([]);
  });

  it('rethrows a crash at before-mark and writes nothing', async () => {
    const env = await bootOutbox();
    await emitCommitted(env, 1);
    env.faults.crashAt = 'outbox.before-mark';
    await expect((await relay('r1')).tick()).to.be.rejectedWith(/crash at outbox.before-mark/);
    const [row] = await outboxRows(env.orders);
    expect(row).to.include({ Status: 'pending', ClaimedBy: 'r1', Attempts: 0 });
  });

  it('publishes a row again after a crash between publish and mark, once the claim ends', async () => {
    const env = await bootOutbox({ outbox: { claimTtl: 30_000, maxPublishMs: 10_000 } });
    await emitCommitted(env, 1);
    env.faults.crashAt = 'outbox.after-publish';
    await expect((await relay('r1')).tick()).to.be.rejectedWith(TestCrash);
    expect(broker.sent).to.have.length(1);
    env.faults.crashAt = undefined;
    await (await relay('r2')).tick();
    expect(broker.sent).to.have.length(1);
    env.clock.set(T0 + 31_000);
    await (await relay('r2')).tick();
    expect(broker.sent.map((s) => s.message.MessageId)).to.deep.equal([broker.sent[0].message.MessageId, broker.sent[0].message.MessageId]);
    const [row] = await outboxRows(env.orders);
    expect(row).to.include({ Status: 'published', ClaimedBy: null, ClaimEpoch: 2, PublishedAt: T0 + 31_000 });
  });

  it('rethrows a crash from the broker and keeps the claim', async () => {
    const env = await bootOutbox();
    await emitCommitted(env, 1);
    broker.failures.set('bus-a', [new TestCrash('broker process died')]);
    await expect((await relay('r1')).tick()).to.be.rejectedWith(TestCrash);
    const [row] = await outboxRows(env.orders);
    expect(row).to.include({ Status: 'pending', ClaimedBy: 'r1', ClaimEpoch: 1 });
  });

  it('lets a row whose publish throws go, goes on with the batch, and publishes the row once its backoff passed', async () => {
    const env = await bootOutbox({ outbox: { backoff: { backoff: 'fixed', delay: 1000 } } });
    await emitCommitted(env, 2);
    broker.failures.set('bus-a', [new Error('broker unavailable')]);
    const r1 = await relay('r1');
    await r1.tick();
    expect(broker.sent.map((s) => orderIdOf(s.message))).to.deep.equal(['2']);
    const [failed] = await outboxRows(env.orders);
    expect(failed).to.include({ Status: 'pending', ClaimedBy: null, ClaimedUntil: null, ClaimEpoch: 1, PublishedAt: null, Attempts: 1 });
    env.clock.set(T0 + 1000);
    await r1.tick();
    expect(broker.sent.map((s) => orderIdOf(s.message))).to.deep.equal(['2', '1']);
    expect((await outboxRows(env.orders)).map((r) => r.Status)).to.deep.equal(['published', 'published']);
  });

  it('claims each row from the time of its own claim, so a batch that took longer than claimTtl - maxPublishMs to read and claim still publishes', async () => {
    const env = await bootOutbox({ outbox: { claimTtl: 30_000, maxPublishMs: 10_000 } });
    await emitCommitted(env, 2);
    // 15 s to read the due rows and 4 s per claim: 23 s in all, past the 20 s margin. From the pass start, both claims
    // would end at +30 s and the stop rule would release them at +23 s, unpublished, on every pass
    const r = await DI.resolve(StoreSwapRelay, [{ replicaId: 'r1', autoStart: false, store: (driver: OrmDriver) => new SlowStore(driver, env.clock, 15_000, 4_000) }]);
    await r.tick();
    expect((await outboxRows(env.orders)).map((row) => row.Status)).to.deep.equal(['published', 'published']);
    expect(broker.sent).to.have.length(2);
  });

  it('releases a row its claim can no longer cover and goes on with the batch, so a slow database still makes progress', async () => {
    const env = await bootOutbox({ outbox: { claimTtl: 30_000, maxPublishMs: 10_000 } });
    await emitCommitted(env, 2);
    // 11 s per claim statement: the first claim has 8 s left once both are made, the second 19 s. Stopping the batch at
    // the first row would release both on every pass
    const r = await DI.resolve(StoreSwapRelay, [{ replicaId: 'r1', autoStart: false, store: (driver: OrmDriver) => new SlowStore(driver, env.clock, 0, 11_000) }]);
    for (let pass = 0; pass < 3; pass++) await r.tick();
    expect((await outboxRows(env.orders)).map((row) => row.Status)).to.deep.equal(['published', 'published']);
    expect(broker.sent.map((s) => orderIdOf(s.message))).to.deep.equal(['2', '1']);
  });

  it('a relay that lost its claims cannot mark the row it published or release the rows it did not reach, and warns of each', async () => {
    const env = await bootOutbox({ outbox: { claimTtl: 30_000, maxPublishMs: 10_000 } });
    await emitCommitted(env, 2);
    const stale = await DI.resolve(LoggedRelay, [{ replicaId: 'r1', autoStart: false }]);
    const run = await takeOver(env, stale);
    const warnings = spyWarnings(stale.queueLog);
    try {
      // r1 finishes its first row at +31 s; its claim on the second ended at +30 s, so it releases that one, fenced
      await run.resumeStale();
    } finally {
      warnings.restore();
    }
    expect(warnings.messages).to.deep.equal([MARK_REFUSED, RELEASE_REFUSED]);
    const [first, second] = await outboxRows(env.orders);
    expect(first).to.include({ Status: 'pending', ClaimedBy: 'r2', ClaimEpoch: 2 });
    expect(second).to.include({ Status: 'pending', ClaimedBy: 'r2', ClaimEpoch: 2, ClaimedUntil: T0 + 61_000 });

    await run.resumeOwner();
    expect((await outboxRows(env.orders)).map((row) => row.Status)).to.deep.equal(['published', 'published']);
  });

  it('a relay that lost its claim warns that it cannot record the failure of its publish', async () => {
    const env = await bootOutbox({ outbox: { claimTtl: 30_000, maxPublishMs: 10_000 } });
    await emitCommitted(env, 2);
    const stale = await DI.resolve(LoggedRelay, [{ replicaId: 'r1', autoStart: false }]);
    const run = await takeOver(env, stale);
    broker.failures.set('bus-a', [new Error('broker down')]);
    const warnings = spyWarnings(stale.queueLog);
    try {
      await run.resumeStale();
    } finally {
      warnings.restore();
    }
    expect(warnings.messages).to.deep.equal([FAILURE_REFUSED, RELEASE_REFUSED]);
    expect((await outboxRows(env.orders))[0]).to.include({ ClaimedBy: 'r2', Attempts: 0, LastError: null });
    await run.resumeOwner();
  });
});
