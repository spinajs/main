/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { ConnectionState, OrmException, QueryContext } from '@spinajs/orm';
import type { Pool } from 'mysql2';

import { MySqlOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/**
 * Minimal stand-in for a `mysql2` PoolConnection. Records the SQL it is asked to run and the
 * lifecycle callbacks the driver invokes, so the transaction primitives can be verified without
 * a live server. The live-database coverage lives in `test/integration/transaction.test.ts`.
 */
class FakePoolConnection {
  public statements: string[] = [];
  public events: string[] = [];
  public released = 0;

  constructor(private readonly failure?: () => Error) {}

  public query(stmt: string, paramsOrCb: any, cb?: any) {
    const callback = typeof paramsOrCb === 'function' ? paramsOrCb : cb;
    this.statements.push(stmt);
    callback?.(this.failure?.() ?? null, []);
  }

  public beginTransaction(cb: (err?: unknown) => void) {
    this.events.push('begin');
    cb(null as any);
  }

  public commit(cb: (err?: unknown) => void) {
    this.events.push('commit');
    cb(null as any);
  }

  public rollback(cb: (err?: unknown) => void) {
    this.events.push('rollback');
    cb(null as any);
  }

  public release() {
    this.released++;
    this.events.push('release');
  }
}

class FakePool {
  public handedOut: FakePoolConnection[] = [];
  public failWith?: () => Error;
  public ended = 0;

  public getConnection(cb: (err: unknown, connection: FakePoolConnection) => void) {
    const connection = new FakePoolConnection(this.failWith);
    this.handedOut.push(connection);
    cb(null, connection);
  }

  public end(cb?: () => void) {
    this.ended++;
    cb?.();
  }

  public query(_stmt: string, paramsOrCb: any, cb?: any) {
    const callback = typeof paramsOrCb === 'function' ? paramsOrCb : cb;
    callback?.(null, []);
  }
}

/**
 * Exposes the protected primitives and swaps the pool for a fake. Everything else — the
 * commit/rollback/dispose ordering — is inherited from `OrmDriver`.
 */
class TestableMySqlDriver extends MySqlOrmDriver {
  public FakePool = new FakePool();

  constructor(options: object = {}) {
    super({ Driver: 'orm-driver-mysql', Name: 'mysql-unit', ...options } as any);
    (this as any).Pool = this.FakePool;
    (this as any).Log = {
      timeStart: () => undefined,
      timeEnd: () => 0,
      write: () => Promise.resolve(),
      warn: () => undefined,
      trace: () => undefined,
    };
  }

  public get LastConnection() {
    return this.FakePool.handedOut[this.FakePool.handedOut.length - 1];
  }
}

describe('MySQL transaction primitives', () => {
  it('acquires a connection, commits and releases it exactly once', async () => {
    const driver = new TestableMySqlDriver();

    await driver.transaction(async () => 'ok');

    expect(driver.FakePool.handedOut).to.have.length(1);
    expect(driver.LastConnection.events).to.deep.equal(['begin', 'commit', 'release']);
    expect(driver.LastConnection.released).to.equal(1);
  });

  it('rolls back and still releases the connection when the callback throws', async () => {
    const driver = new TestableMySqlDriver();

    await expect(
      driver.transaction(async () => {
        throw new Error('boom');
      }),
    ).to.be.rejectedWith('boom');

    expect(driver.LastConnection.events).to.deep.equal(['begin', 'rollback', 'release']);
    expect(driver.LastConnection.released).to.equal(1);
  });

  it('issues SAVEPOINT / RELEASE SAVEPOINT for a nested transaction', async () => {
    const driver = new TestableMySqlDriver();

    await driver.transaction(async () => {
      await driver.transaction(async () => 'inner');
    });

    expect(driver.LastConnection.statements).to.deep.equal(['SAVEPOINT `sp_1`', 'RELEASE SAVEPOINT `sp_1`']);
    // one connection for the whole nest — nesting must not acquire a second one
    expect(driver.FakePool.handedOut).to.have.length(1);
  });

  it('issues ROLLBACK TO SAVEPOINT when only the nested block fails', async () => {
    const driver = new TestableMySqlDriver();

    await driver.transaction(async () => {
      await driver
        .transaction(async () => {
          throw new Error('inner');
        })
        .catch(() => undefined);
    });

    expect(driver.LastConnection.statements).to.deep.equal(['SAVEPOINT `sp_1`', 'ROLLBACK TO SAVEPOINT `sp_1`']);
    expect(driver.LastConnection.events).to.deep.equal(['begin', 'commit', 'release']);
  });

  it('sets the isolation level before beginning the transaction', async () => {
    const driver = new TestableMySqlDriver();

    await driver.transaction(async () => 'ok', { isolation: 'SERIALIZABLE' });

    expect(driver.LastConnection.statements[0]).to.equal('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
  });

  it('declares support for all four standard isolation levels', () => {
    const driver = new TestableMySqlDriver();

    expect(driver.SupportedIsolationLevels).to.deep.equal(['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']);
  });

  it('never acquires a connection when the isolation level is unsupported', async () => {
    const driver = new TestableMySqlDriver();
    (driver as any).SupportedIsolationLevels = ['READ COMMITTED'];

    await expect(driver.transaction(async () => 1, { isolation: 'SERIALIZABLE' })).to.be.rejected;
    expect(driver.FakePool.handedOut).to.have.length(0);
  });
});

/** Counts the pools a reconnect opens; the replacement is the fake pool itself, so no server is needed. */
class ReconnectingMySqlDriver extends TestableMySqlDriver {
  public opened = 0;
  public states: ConnectionState[] = [];

  constructor() {
    super({ Resilience: { MaxRetries: 2, RetryDelay: 1, MaxRetryDelay: 1, HealthCheckInterval: 0 } });
  }

  protected openPool(): Promise<Pool> {
    this.opened++;
    return Promise.resolve(this.Pool);
  }

  protected setState(state: ConnectionState): void {
    super.setState(state);
    this.states.push(state);
  }
}

const serverError = (message: string, fields: object) => () => Object.assign(new Error(message), fields);
const lockWaitTimeout = serverError('Lock wait timeout exceeded; try restarting transaction', { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205, sqlState: 'HY000', fatal: false });

describe('MySQL statement retry outside a transaction', () => {
  it('surfaces a lock wait timeout after one wait, keeping the pool and the connection state', async () => {
    const driver = new ReconnectingMySqlDriver();
    driver.FakePool.failWith = lockWaitTimeout;

    const error = await driver.executeOnDb('UPDATE t SET a = 1 WHERE id = 1', [], QueryContext.Update).then(() => undefined, (err: unknown) => err);

    expect(error).to.be.instanceOf(OrmException).and.to.have.nested.property('inner.code', 'ER_LOCK_WAIT_TIMEOUT');
    expect(driver.FakePool.handedOut).to.have.length(1);
    expect(driver.opened).to.equal(0);
    expect(driver.FakePool.ended).to.equal(0);
    expect(driver.states).to.deep.equal([]);
  });

  for (const [name, failure] of [
    ['a lost connection', serverError('Connection lost: The server closed the connection.', { code: 'PROTOCOL_CONNECTION_LOST', fatal: true })],
    ['a reset socket', serverError('read ECONNRESET', { code: 'ECONNRESET', errno: -4077 })],
  ] as const) {
    it(`retries ${name} on a new pool`, async () => {
      const driver = new ReconnectingMySqlDriver();
      driver.FakePool.failWith = failure;

      await expect(driver.executeOnDb('UPDATE t SET a = 1 WHERE id = 1', [], QueryContext.Update)).to.be.rejectedWith(OrmException);

      expect(driver.FakePool.handedOut).to.have.length(3);
      expect(driver.opened).to.equal(2);
      expect(driver.states).to.include(ConnectionState.Degraded);
    });
  }
});
