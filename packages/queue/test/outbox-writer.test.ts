import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { InvalidConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { MigrationSource, OrmException } from '@spinajs/orm';
import { assertInsertOrIgnore, OutboxAmbiguousTransaction, OutboxConnectionNotCovered, OutboxMessageIdConflict, OutboxWriter, QueueHeaders, QueueOutboxMigrationSource, QueueService, startOutboxService } from '../src/index.js';
import { bootOutbox, bootOutboxDb, broker, BuildReport, disposeOutbox, eventually, faultsHit, OrderPlaced, outboxRows, T0 } from './support/outbox-env.js';

/** The outbox migration source on a dialect without insert-or-ignore, as orm-mssql is before it implements orIgnore(). */
class RefusingOutboxSource extends QueueOutboxMigrationSource {
  protected probe(): void {
    throw new OrmException('insert or ignore is not supported');
  }
}

chai.use(chaiAsPromised);
const { expect } = chai;

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('queue outbox: writer and emit()', function () {
  this.timeout(30_000);
  afterEach(disposeOutbox);

  it('writes a row in the ambient transaction and publishes nothing', async () => {
    const env = await bootOutbox();
    await env.orders.transaction(async () => {
      await env.queue.emit(new OrderPlaced({ OrderId: '1', Headers: { [QueueHeaders.TraceParent]: TRACEPARENT } }));
    });
    const [row] = await outboxRows(env.orders);
    expect(row).to.include({ Name: 'OrderPlaced', Type: 'EVENT', Status: 'pending', Attempts: 0, AvailableAt: T0, CreatedAt: T0, TraceParent: TRACEPARENT });
    expect(JSON.parse(row.Message)).to.include({ OrderId: '1', MessageId: row.MessageId });
    expect(broker.sent).to.deep.equal([]);
    expect(faultsHit.map((f) => f.name)).to.deep.equal(['outbox.after-insert']);
  });

  it('writes nothing when the transaction rolls back', async () => {
    const env = await bootOutbox();
    await expect(
      env.orders.transaction(async () => {
        await env.queue.emit(new OrderPlaced({ OrderId: '1' }));
        throw new Error('business rule failed');
      }),
    ).to.be.rejectedWith('business rule failed');
    expect(await outboxRows(env.orders)).to.deep.equal([]);
    expect(broker.sent).to.deep.equal([]);
  });

  it('uses the connection whose transaction is open', async () => {
    const env = await bootOutbox();
    await env.billing.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '2' })));
    expect(await outboxRows(env.orders)).to.have.length(0);
    expect(await outboxRows(env.billing)).to.have.length(1);
  });

  it('refuses to guess between two open transactions', async () => {
    const env = await bootOutbox();
    await expect(env.orders.transaction(() => env.billing.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '3' }))))).to.be.rejectedWith(OutboxAmbiguousTransaction);
  });

  it('refuses an emit inside a transaction on a connection the outbox does not cover, and names it', async () => {
    const env = await bootOutbox();
    const refused = await env.uncovered.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: 'u1' }))).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).to.be.instanceOf(OutboxConnectionNotCovered);
    expect(refused).to.have.property('message').that.matches(/"queue".*queue\.outbox\.connections/);
    expect(refused).to.have.deep.property('connections', ['queue']);
    expect(broker.sent).to.deep.equal([]);
    expect(await outboxRows(env.orders)).to.deep.equal([]);
  });

  it('refuses it in always mode too, where the row would survive the rollback', async () => {
    const env = await bootOutbox({ outbox: { mode: 'always' } });
    await expect(env.uncovered.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: 'u2' })))).to.be.rejectedWith(OutboxConnectionNotCovered);
    expect(await outboxRows(env.orders)).to.deep.equal([]);
  });

  it('joins the covered transaction when an uncovered one is open around it', async () => {
    const env = await bootOutbox();
    await env.uncovered.transaction(() => env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: 'u3' }))));
    expect(await outboxRows(env.orders)).to.have.length(1);
    expect(broker.sent).to.deep.equal([]);
  });

  it('does not look at transactions while the outbox is off', async () => {
    const env = await bootOutbox({ outbox: { enabled: false } });
    await env.uncovered.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: 'u4' })));
    expect(broker.sent).to.have.length(1);
  });

  it('names the connection, the driver and orIgnore() when a dialect cannot insert-or-ignore', async () => {
    const env = await bootOutbox();
    const target = { connection: 'orders', driver: env.orders };
    expect(() => assertInsertOrIgnore(target)).to.not.throw();
    const refuse = () => {
      throw new OrmException('mssql insert or ignore is not supported');
    };
    expect(() => assertInsertOrIgnore(target, refuse)).to.throw(InvalidConfiguration, /"orders".*orm-driver-sqlite.*orIgnore\(\).*mssql insert or ignore is not supported/);
  });

  it('fails the Orm boot on such a connection, before the queue service exists or anything emits', async () => {
    // disposeOutbox restores the registrations from before the boot, which takes this one out again
    const booting = bootOutboxDb({ register: () => DI.register(RefusingOutboxSource).as(MigrationSource) });
    await expect(booting).to.be.rejectedWith(InvalidConfiguration, /"orders".*orIgnore\(\)/);
    expect(DI.get(QueueService) instanceof QueueService).to.equal(false);
    expect(broker.sent).to.deep.equal([]);
  });

  it('fails the Orm boot on an outbox connection that does not exist', async () => {
    await expect(bootOutboxDb({ outbox: { connections: ['orders', 'nowhere'] } })).to.be.rejectedWith(InvalidConfiguration, /"nowhere"/);
  });

  it('resolves the queue service when the Orm boots, without an emit', async () => {
    await bootOutboxDb({ bootstrap: true });
    // the listener starts the resolve when the Orm is cached and nobody hands out its promise
    await eventually(() => DI.get(QueueService) instanceof QueueService);
    expect(broker.sent).to.deep.equal([]);
  });

  it('resolves nothing at boot while the outbox is off', async () => {
    await bootOutboxDb({ bootstrap: true, outbox: { enabled: false } });
    expect(await startOutboxService()).to.equal(undefined);
    expect(DI.get(QueueService) instanceof QueueService).to.equal(false);
  });

  it('refuses a MessageId longer than the column', async () => {
    const env = await bootOutbox();
    const message = new OrderPlaced({ OrderId: 'long', MessageId: 'm'.repeat(129) });
    await expect(env.orders.transaction(() => env.queue.emit(message))).to.be.rejectedWith(/MessageId/);
    expect(await outboxRows(env.orders)).to.deep.equal([]);
  });

  it('publishes directly outside a transaction in when-in-transaction mode', async () => {
    const env = await bootOutbox();
    await env.queue.emit(new OrderPlaced({ OrderId: '4' }));
    expect(broker.sent.map((s) => s.connection)).to.deep.equal(['bus-a']);
    expect(await outboxRows(env.orders)).to.deep.equal([]);
  });

  it('writes a row in autocommit in always mode', async () => {
    const env = await bootOutbox({ outbox: { mode: 'always' } });
    await env.queue.emit(new OrderPlaced({ OrderId: '5' }));
    expect(await outboxRows(env.orders)).to.have.length(1);
    expect(broker.sent).to.deep.equal([]);
  });

  it('publishes directly when the outbox is off', async () => {
    const env = await bootOutbox({ outbox: { enabled: false } });
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '6' })));
    expect(broker.sent).to.have.length(1);
  });

  it('keeps one row for a repeated MessageId', async () => {
    const env = await bootOutbox();
    const writer = await DI.resolve(OutboxWriter);
    const message = new OrderPlaced({ OrderId: '7', MessageId: '11111111-1111-4111-8111-111111111111' });
    await env.orders.transaction(async () => {
      expect(await writer.enlist(message)).to.equal(true);
      expect(await writer.enlist(message)).to.equal(true);
    });
    expect(await outboxRows(env.orders)).to.have.length(1);
  });

  it('refuses a MessageId whose stored row is another message, or is dead', async () => {
    const env = await bootOutbox();
    const id = '33333333-3333-4333-8333-333333333333';
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '9', MessageId: id })));
    const other = new BuildReport();
    other.MessageId = id;
    await expect(env.orders.transaction(() => env.queue.emit(other))).to.be.rejectedWith(OutboxMessageIdConflict, /OrderPlaced/);
    await env.orders.update().in('queue_outbox').update({ Status: 'dead' }).where({ MessageId: id });
    await expect(env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '9', MessageId: id })))).to.be.rejectedWith(OutboxMessageIdConflict, /dead/);
    expect(await outboxRows(env.orders)).to.have.length(1);
    expect(broker.sent).to.deep.equal([]);
  });

  it('returns the JobId from emit() as without the outbox', async () => {
    const env = await bootOutbox();
    const job = new BuildReport();
    job.JobId = 'job-1';
    expect(await env.orders.transaction(() => env.queue.emit(job))).to.equal('job-1');
    expect((await outboxRows(env.orders))[0]).to.include({ Name: 'BuildReport', Type: 'JOB', MessageId: job.MessageId });
  });

  it('skips the connections in skip and reports the confirmed ones through publishDirect', async () => {
    const env = await bootOutbox({ routing: { OrderPlaced: [{ connection: 'bus-a' }, { connection: 'bus-b' }] } });
    const published: string[] = [];
    await env.queue.publishDirect(new OrderPlaced({ OrderId: '8', MessageId: '22222222-2222-4222-8222-222222222222' }), { skip: ['bus-a'], published });
    expect(published).to.deep.equal(['bus-b']);
    expect(broker.sent.map((s) => s.connection)).to.deep.equal(['bus-b']);
  });
});
