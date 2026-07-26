/* eslint-disable prettier/prettier */
import { expect } from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { OrmMetricsSink, NullOrmMetricsSink, ORM_METRIC_POOL_SIZE, ORM_METRIC_POOL_IN_USE, ORM_METRIC_POOL_WAITING, ORM_METRIC_CONNECTION_STATE } from '../src/metrics.js';
import { ConnectionState } from '../src/resilience.js';
import { OrmDriver } from '../src/driver.js';
import { IColumnDescriptor, ISupportedFeature, ITransactionContext, ITransactionOptions } from '../src/interfaces.js';
import { Builder } from '../src/builders.js';

class RecordingSink extends OrmMetricsSink {
  public gauges: Array<{ name: string; labels: Record<string, string>; value: number }> = [];
  public observations: Array<{ name: string; seconds: number }> = [];

  public gauge(name: string, _help: string, labels: Record<string, string>, value: number): void {
    this.gauges.push({ name, labels, value });
  }

  public observe(name: string, _help: string, _labels: Record<string, string>, seconds: number): void {
    this.observations.push({ name, seconds });
  }
}

/**
 * A driver that overrides nothing beyond the abstract members, so `poolMetrics()` is whatever
 * the base class provides.
 */
class BareDriver extends OrmDriver {
  public execute(_b: Builder<any>): Promise<any> { return Promise.resolve([]); }
  public async ping(): Promise<boolean> { return true; }
  public async connect(): Promise<OrmDriver> { return this; }
  public async disconnect(): Promise<OrmDriver> { return this; }
  public supportedFeatures(): ISupportedFeature { return { events: false, insertReturning: false }; }
  public tableInfo(_n: string): Promise<IColumnDescriptor[]> { return Promise.resolve([]); }

  protected async _begin(_o?: ITransactionOptions): Promise<ITransactionContext> { return { depth: 0 }; }
  protected async _commit(_c: ITransactionContext): Promise<void> { /* no-op */ }
  protected async _rollback(_c: ITransactionContext): Promise<void> { /* no-op */ }
  protected async _savepoint(_c: ITransactionContext, _n: string): Promise<void> { /* no-op */ }
  protected async _releaseSavepoint(_c: ITransactionContext, _n: string): Promise<void> { /* no-op */ }
  protected async _rollbackToSavepoint(_c: ITransactionContext, _n: string): Promise<void> { /* no-op */ }
  protected async _dispose(_c: ITransactionContext): Promise<void> { /* no-op */ }
}

class MetricDriver extends BareDriver {
  public poolMetrics() { return { Size: 4, InUse: 1, Waiting: 2 }; }
  public forceState(s: ConnectionState) { this.setState(s); }
}

function stub<T extends OrmDriver>(d: T): T {
  (d as any).Log = { info: () => undefined, warn: () => undefined, trace: () => undefined, error: () => undefined };
  (d as any).Container = DI.child();
  return d;
}

describe('pool metrics', () => {
  afterEach(() => DI.clearCache());

  it('the default sink discards without throwing', () => {
    const s = new NullOrmMetricsSink();
    expect(() => s.gauge('a', 'h', {}, 1)).to.not.throw();
    expect(() => s.observe('a', 'h', {}, 1)).to.not.throw();
  });

  it('publishes size, in-use, waiting and state with a connection label', () => {
    const sink = new RecordingSink();
    DI.register(() => sink).as(OrmMetricsSink);

    const d = stub(new MetricDriver({ Driver: 'fake', Name: 'conn-a' } as any));

    d.publishPoolMetrics();

    const byName = new Map(sink.gauges.map((g) => [g.name, g]));
    expect(byName.get(ORM_METRIC_POOL_SIZE)!.value).to.equal(4);
    expect(byName.get(ORM_METRIC_POOL_IN_USE)!.value).to.equal(1);
    expect(byName.get(ORM_METRIC_POOL_WAITING)!.value).to.equal(2);
    expect(byName.get(ORM_METRIC_POOL_SIZE)!.labels).to.deep.equal({ connection: 'conn-a' });
  });

  it('publishes 1 for connected and 0 otherwise', () => {
    const sink = new RecordingSink();
    DI.register(() => sink).as(OrmMetricsSink);

    const d = stub(new MetricDriver({ Driver: 'fake', Name: 'conn-b' } as any));

    d.forceState(ConnectionState.Connected);
    d.publishPoolMetrics();
    expect(sink.gauges.find((g) => g.name === ORM_METRIC_CONNECTION_STATE)!.value).to.equal(1);

    sink.gauges.length = 0;
    d.forceState(ConnectionState.Degraded);
    d.publishPoolMetrics();
    expect(sink.gauges.find((g) => g.name === ORM_METRIC_CONNECTION_STATE)!.value).to.equal(0);
  });

  it('the base driver reports an empty pool by default', () => {
    const d = new BareDriver({ Driver: 'fake', Name: 'c' } as any);

    expect(d.poolMetrics()).to.deep.equal({ Size: 0, InUse: 0, Waiting: 0 });
  });
});
