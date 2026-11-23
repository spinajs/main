import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Configuration, InvalidConfiguration, registerConfigurationSchema } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { MigrationSource } from '@spinajs/orm';
import { OUTBOX_DEFAULTS, outboxConfig, outboxMigrationName, outboxRetry, QUEUE_OUTBOX_CONFIGURATION_SCHEMA, QueueOutboxMigrationSource, type IQueueOutboxConfig } from '../src/index.js';
import { bootOutbox, disposeOutbox, OrderPlaced, outboxRows } from './support/outbox-env.js';

chai.use(chaiAsPromised);
const { expect } = chai;

async function outboxMigrationNames(): Promise<string[]> {
  const sources = await DI.resolve(Array.ofType(MigrationSource));
  const source = sources.find((s) => s instanceof QueueOutboxMigrationSource);
  if (!source) throw new Error('QueueOutboxMigrationSource is not registered');
  return (await source.getMigrations()).map((m) => m.name);
}

describe('queue outbox: config, schema and table', function () {
  this.timeout(30_000);
  afterEach(disposeOutbox);

  it('fills defaults and keeps an explicit value', () => {
    const c = outboxConfig({ enabled: true, batchSize: 7 });
    expect(c).to.include({ enabled: true, relay: true, mode: 'when-in-transaction', batchSize: 7, claimTtl: 30_000, maxPublishMs: 10_000, maxAge: '24h', retention: '7d' });
    expect(c.connections).to.deep.equal(['default']);
    expect(outboxConfig(undefined)).to.deep.equal(OUTBOX_DEFAULTS);
  });

  it('refuses maxPublishMs at or above claimTtl, an empty connection list, a bad retention and a bad or zero maxAge', () => {
    expect(() => outboxConfig({ enabled: true, claimTtl: 10_000, maxPublishMs: 10_000 })).to.throw(/maxPublishMs/);
    expect(() => outboxConfig({ enabled: true, connections: [] })).to.throw(/connections/);
    expect(() => outboxConfig({ enabled: true, retention: 'soon' })).to.throw(/retention/);
    expect(() => outboxConfig({ enabled: true, maxAge: 'later' })).to.throw(/maxAge/);
    expect(() => outboxConfig({ enabled: true, maxAge: 0 })).to.throw(/maxAge/);
  });

  it('does not judge the values of a disabled outbox', () => {
    expect(outboxConfig({ enabled: false, connections: [], retention: 'soon' }).enabled).to.equal(false);
  });

  it('maps backoff onto a NormalizedRetry without an attempt limit', () => {
    expect(outboxRetry(outboxConfig({ backoff: { backoff: 'fixed', delay: '2s' } }))).to.deep.include({ attempts: Number.POSITIVE_INFINITY, backoff: 'fixed', delayMs: 2000 });
  });

  it('names one migration per connection', () => {
    expect(outboxMigrationName('orders')).to.equal('QueueOutbox_orders_2026_11_16_00_00_00');
    expect(outboxMigrationName('billing-eu')).to.equal('QueueOutbox_billing_eu_2026_11_16_00_00_00');
  });

  it('hands one migration per database when a connection is listed under two names', async () => {
    // `default` is `orders` (db.DefaultConnection)
    await bootOutbox({ outbox: { connections: ['default', 'orders', 'billing'] } });
    expect(await outboxMigrationNames()).to.deep.equal([outboxMigrationName('orders'), outboxMigrationName('billing')]);
  });

  it('creates queue_outbox on every configured connection', async () => {
    const env = await bootOutbox();
    for (const driver of [env.orders, env.billing]) {
      await driver.insert().into('queue_outbox').values({ MessageId: 'm-1', Name: OrderPlaced.name, Type: 'EVENT', Message: '{}', Status: 'pending', Attempts: 0, AvailableAt: 1, CreatedAt: 1, ClaimEpoch: 0 });
      const [row] = await outboxRows(driver);
      expect(row).to.include({ MessageId: 'm-1', Status: 'pending', ClaimedBy: null, TraceParent: null, PublishedAt: null });
      expect(row.PublishedTo).to.deep.equal([]);
    }
  });

  it('hands no migration to the Orm while the outbox is off', async () => {
    await bootOutbox({ outbox: { enabled: false } });
    expect(await outboxMigrationNames()).to.deep.equal([]);
  });

  it('keeps numeric and string durations as they were written, through the schema the Bootstrappers register', async () => {
    await bootOutbox({ bootstrap: true, outbox: { maxAge: 3_600_000, retention: '2d', backoff: { backoff: 'fixed', delay: 1000, maxDelay: '5m' } } });
    const stored = outboxConfig((await DI.resolve(Configuration)).get<Partial<IQueueOutboxConfig> | undefined>('queue.outbox'));
    expect(stored).to.include({ maxAge: 3_600_000, retention: '2d' });
    expect(stored.backoff).to.deep.equal({ backoff: 'fixed', delay: 1000, maxDelay: '5m' });
    expect(outboxRetry(stored)).to.deep.include({ backoff: 'fixed', delayMs: 1000, maxDelayMs: 300_000 });
  });

  it('reads a numeric string as milliseconds once the schema is registered', async () => {
    await bootOutbox({ bootstrap: true, outbox: { retention: '86400000' } });
    const stored = outboxConfig((await DI.resolve(Configuration)).get<Partial<IQueueOutboxConfig> | undefined>('queue.outbox'));
    expect(stored.retention).to.equal(86_400_000);
  });

  it('validates queue.outbox against its schema', async () => {
    // 1 ms is a number, so the type accepts it; the schema wants at least 10
    await bootOutbox({ outbox: { tick: 1 } });
    expect(() => registerConfigurationSchema(QUEUE_OUTBOX_CONFIGURATION_SCHEMA, DI.RootContainer)).to.throw(InvalidConfiguration, /tick/);
  });

  it('refuses a duration without a unit that is not a number', async () => {
    await bootOutbox({ outbox: { enabled: false, backoff: { delay: 'soon' } } });
    expect(() => registerConfigurationSchema(QUEUE_OUTBOX_CONFIGURATION_SCHEMA, DI.RootContainer)).to.throw(InvalidConfiguration, /delay/);
  });

  it('refuses null, a boolean, an empty string, a negative number and a fraction of a millisecond as a duration', async function () {
    this.timeout(120_000);
    // null and false would be stored as 0 and true as 1 by a schema whose integer branch came first
    for (const retention of [null, true, false, '', -5, 1.5]) {
      await bootOutbox({ rawOutbox: { enabled: false, retention } });
      expect(() => registerConfigurationSchema(QUEUE_OUTBOX_CONFIGURATION_SCHEMA, DI.RootContainer), JSON.stringify(retention)).to.throw(InvalidConfiguration, /retention/);
      await disposeOutbox();
    }
  });

  it('keeps zero where zero has a meaning, and refuses it for maxAge', async function () {
    this.timeout(60_000);
    await bootOutbox({ bootstrap: true, outbox: { retention: 0, backoff: { backoff: 'fixed', delay: 0, maxDelay: '0s' } } });
    const stored = outboxConfig((await DI.resolve(Configuration)).get<Partial<IQueueOutboxConfig> | undefined>('queue.outbox'));
    expect(stored.retention).to.equal(0);
    expect(stored.backoff).to.deep.equal({ backoff: 'fixed', delay: 0, maxDelay: '0s' });
    await disposeOutbox();
    for (const maxAge of [0, '0s']) {
      await bootOutbox({ outbox: { enabled: false, maxAge } });
      expect(() => registerConfigurationSchema(QUEUE_OUTBOX_CONFIGURATION_SCHEMA, DI.RootContainer), JSON.stringify(maxAge)).to.throw(InvalidConfiguration, /maxAge/);
      await disposeOutbox();
    }
  });
});
