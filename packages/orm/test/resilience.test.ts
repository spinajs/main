/* eslint-disable prettier/prettier */
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { backoffDelay, ConnectionState } from '../src/resilience.js';
import { OrmDriver } from '../src/driver.js';
import { IColumnDescriptor, ISupportedFeature, ITransactionContext, ITransactionOptions } from '../src/interfaces.js';
import { Builder } from '../src/builders.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

class FakeResilientDriver extends OrmDriver {
  public connectCalls = 0;
  public attempts = 0;
  public failTimes = 0;
  public failCode = 'ECONNRESET';
  public pingResult = true;

  /** Every state the driver passed through, in order. */
  public states: ConnectionState[] = [];

  public execute(_builder: Builder<any>): Promise<any> {
    return Promise.resolve([]);
  }

  public async ping(): Promise<boolean> {
    return this.pingResult;
  }

  public async connect(): Promise<OrmDriver> {
    this.connectCalls++;
    return this;
  }

  public async disconnect(): Promise<OrmDriver> {
    return this;
  }

  public supportedFeatures(): ISupportedFeature {
    return { events: false, insertReturning: false };
  }

  public tableInfo(_name: string): Promise<IColumnDescriptor[]> {
    return Promise.resolve([]);
  }

  public run() {
    return this.withReconnect(async () => {
      this.attempts++;
      if (this.attempts <= this.failTimes) {
        const err: any = new Error('transport down');
        err.code = this.failCode;
        throw err;
      }
      return 'ok';
    });
  }

  protected setState(state: ConnectionState): void {
    super.setState(state);
    this.states.push(state);
  }

  public expose() {
    return { setState: (s: ConnectionState) => this.setState(s) };
  }

  protected async _begin(_options?: ITransactionOptions): Promise<ITransactionContext> {
    return { depth: 0 };
  }

  protected async _commit(_ctx: ITransactionContext): Promise<void> {
    // no-op
  }

  protected async _rollback(_ctx: ITransactionContext): Promise<void> {
    // no-op
  }

  protected async _savepoint(_ctx: ITransactionContext, _name: string): Promise<void> {
    // no-op
  }

  protected async _releaseSavepoint(_ctx: ITransactionContext, _name: string): Promise<void> {
    // no-op
  }

  protected async _rollbackToSavepoint(_ctx: ITransactionContext, _name: string): Promise<void> {
    // no-op
  }

  protected async _dispose(_ctx: ITransactionContext): Promise<void> {
    // no-op
  }
}

function driver(options: any = {}) {
  const d = new FakeResilientDriver({
    Driver: 'fake',
    Name: 'fake',
    Resilience: { RetryDelay: 1, MaxRetryDelay: 2, MaxRetries: 3, HealthCheckInterval: 0 },
    ...options,
  } as any);
  (d as any).Log = { info: () => undefined, warn: () => undefined, error: () => undefined, trace: () => undefined };
  return d;
}

describe('connection resilience', () => {
  it('backoffDelay doubles and clamps', () => {
    expect(backoffDelay(0, 200, 5000)).to.equal(200);
    expect(backoffDelay(1, 200, 5000)).to.equal(400);
    expect(backoffDelay(2, 200, 5000)).to.equal(800);
    expect(backoffDelay(10, 200, 5000)).to.equal(5000);
  });

  it('a driver starts disconnected', () => {
    expect(driver().State).to.equal(ConnectionState.Disconnected);
  });

  it('passes a successful operation straight through without reconnecting', async () => {
    const d = driver();

    expect(await d.run()).to.equal('ok');
    expect(d.attempts).to.equal(1);
    expect(d.connectCalls).to.equal(0);
  });

  it('retries a retryable transport error and reconnects between attempts', async () => {
    const d = driver();
    d.failTimes = 2;

    expect(await d.run()).to.equal('ok');
    expect(d.attempts).to.equal(3);
    expect(d.connectCalls).to.equal(2);
  });

  it('does not retry a query error', async () => {
    const d = driver();
    d.failTimes = 5;
    d.failCode = 'ER_PARSE_ERROR';

    await expect(d.run()).to.be.rejectedWith('transport down');
    expect(d.attempts).to.equal(1);
    expect(d.connectCalls).to.equal(0);
  });

  it('gives up after MaxRetries and rethrows the last error', async () => {
    const d = driver();
    d.failTimes = 99;

    await expect(d.run()).to.be.rejectedWith('transport down');
    expect(d.attempts).to.equal(4); // 1 initial + 3 retries
  });

  it('marks the driver degraded while retrying and connected once it recovers', async () => {
    const d = driver();
    d.failTimes = 1;

    await d.run();

    expect(d.states).to.include(ConnectionState.Degraded);
    expect(d.State).to.equal(ConnectionState.Connected);
  });
});
