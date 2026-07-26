/* eslint-disable prettier/prettier */
import { expect } from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry-common';
import { ORM_METRIC_POOL_SIZE, ORM_METRIC_POOL_IN_USE, ORM_METRIC_POOL_WAITING, ORM_METRIC_CONNECTION_STATE, ORM_METRIC_ACQUIRE_SECONDS } from '../src/metrics.js';
import { ConnectionState } from '../src/resilience.js';
import { OrmDriver } from '../src/driver.js';
import { IColumnDescriptor, ISupportedFeature, ITransactionContext, ITransactionOptions } from '../src/interfaces.js';
import { Builder } from '../src/builders.js';

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

/**
 * `Metrics` is a `@Singleton()`, so this is the very instance the driver publishes into. Every
 * test gets a fresh one because `afterEach` clears the DI cache — the ORM keys its one-time
 * `defineMetrics` call on the service instance, so a new service means a clean registry.
 */
function metrics(): Metrics {
  return DI.get(Metrics) ?? DI.resolve(Metrics);
}

describe('pool metrics', () => {
  afterEach(() => DI.clearCache());

  it('publishes size, in-use, waiting and state with a connection label', async () => {
    const m = metrics();
    const d = stub(new MetricDriver({ Driver: 'fake', Name: 'conn-a' } as any));

    d.publishPoolMetrics();

    const out = await m.render();
    expect(out).to.contain(`${ORM_METRIC_POOL_SIZE}{connection="conn-a"} 4`);
    expect(out).to.contain(`${ORM_METRIC_POOL_IN_USE}{connection="conn-a"} 1`);
    expect(out).to.contain(`${ORM_METRIC_POOL_WAITING}{connection="conn-a"} 2`);
  });

  it('publishes 1 for connected and 0 otherwise', async () => {
    const m = metrics();
    const d = stub(new MetricDriver({ Driver: 'fake', Name: 'conn-b' } as any));

    d.forceState(ConnectionState.Connected);
    d.publishPoolMetrics();
    expect(await m.render()).to.contain(`${ORM_METRIC_CONNECTION_STATE}{connection="conn-b"} 1`);

    d.forceState(ConnectionState.Degraded);
    d.publishPoolMetrics();
    expect(await m.render()).to.contain(`${ORM_METRIC_CONNECTION_STATE}{connection="conn-b"} 0`);
  });

  it('records pool acquire waits as a histogram', async () => {
    const m = metrics();
    const d = stub(new MetricDriver({ Driver: 'fake', Name: 'conn-c' } as any));

    d.observeAcquireSeconds(0.25);
    d.observeAcquireSeconds(0.75);

    const out = await m.render();
    expect(out).to.contain(`${ORM_METRIC_ACQUIRE_SECONDS}_count{connection="conn-c"} 2`);
    expect(out).to.contain(`${ORM_METRIC_ACQUIRE_SECONDS}_sum{connection="conn-c"} 1`);
  });

  it('publishing never throws, even for a driver built outside DI', () => {
    const d = new MetricDriver({ Driver: 'fake', Name: 'conn-d' } as any);

    expect(() => d.publishPoolMetrics()).to.not.throw();
    expect(() => d.observeAcquireSeconds(1)).to.not.throw();
  });

  it('the base driver reports an empty pool by default', () => {
    const d = new BareDriver({ Driver: 'fake', Name: 'c' } as any);

    expect(d.poolMetrics()).to.deep.equal({ Size: 0, InUse: 0, Waiting: 0 });
  });
});
