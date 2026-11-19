import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import * as sinon from 'sinon';
// the index first: importing driver.js on its own hits an import cycle
import { Builder, ConnectionState, IColumnDescriptor, ISupportedFeature, ITransactionContext, OrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/** Changes state the way the sqlite, mysql and postgres drivers do: connect() and disconnect() set it themselves. */
class StateDriver extends OrmDriver {
  public execute(_builder: Builder<unknown>): Promise<unknown[]> {
    return Promise.resolve([]);
  }

  public async ping(): Promise<boolean> {
    return true;
  }

  public async connect(): Promise<OrmDriver> {
    this.setState(ConnectionState.Connected);
    return this;
  }

  public async disconnect(): Promise<OrmDriver> {
    this.stopHealthCheck();
    this.setState(ConnectionState.Disconnected);
    return this;
  }

  public supportedFeatures(): ISupportedFeature {
    return { events: false, insertReturning: false };
  }

  public tableInfo(_name: string): Promise<IColumnDescriptor[]> {
    return Promise.resolve([]);
  }

  public runOnDeadTransport() {
    return this.withReconnect(async () => {
      const err = new Error('transport down') as Error & { code: string };
      err.code = 'ECONNRESET';
      throw err;
    });
  }

  protected async _begin(): Promise<ITransactionContext> {
    return { depth: 0 };
  }

  protected async _commit(): Promise<void> {}

  protected async _rollback(): Promise<void> {}

  protected async _savepoint(): Promise<void> {}

  protected async _releaseSavepoint(): Promise<void> {}

  protected async _rollbackToSavepoint(): Promise<void> {}

  protected async _dispose(): Promise<void> {}
}

function driverWithLog() {
  const d = new StateDriver({ Driver: 'fake', Name: 'main', Resilience: { RetryDelay: 1, MaxRetryDelay: 1, MaxRetries: 1, HealthCheckInterval: 0 } });
  const log = { trace: sinon.stub(), debug: sinon.stub(), info: sinon.stub(), success: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
  Object.assign(d, { Log: log });
  return { d, log };
}

const toDisconnected = (stub: sinon.SinonStub) => stub.getCalls().filter((c) => (c.args[0] as { state?: string })?.state === ConnectionState.Disconnected);

describe('the log level of a disconnect', () => {
  it('logs a planned disconnect at debug, not at warn', async () => {
    const { d, log } = driverWithLog();
    await d.connect();

    await d.disconnect();

    expect(toDisconnected(log.warn), 'warn').to.have.length(0);
    expect(toDisconnected(log.debug), 'debug').to.have.length(1);
    expect(toDisconnected(log.debug)[0].args).to.deep.equal([{ connection: 'main', state: 'disconnected', previousState: 'connected' }, 'connection ${connection} is ${state} (was ${previousState})']);
  });

  it('logs a connection lost after the last reconnect attempt at warn', async () => {
    const { d, log } = driverWithLog();
    await d.connect();

    await expect(d.runOnDeadTransport()).to.be.rejectedWith('transport down');

    expect(toDisconnected(log.warn), 'warn').to.have.length(1);
    expect(toDisconnected(log.debug), 'debug').to.have.length(0);
  });
});
